import { analyze } from './analyze.js';
import { fillPath, getPath, UndoableClient, type CallInput, type HttpResult } from './runtime.js';
import type { ApiSpec, InversePlan, Operation, RequestTemplate, Reversibility, Schema, Strategy } from './types.js';
import { VERSION } from './version.js';

export interface FixtureStep {
  operationId: string;
  params?: Record<string, string | number>;
  body?: unknown;
}

export interface Fixture {
  /** Fixed path params to use instead of creating resources. */
  params?: Record<string, string | number>;
  /** Request body to send instead of a synthesized one. */
  body?: unknown;
  /** Calls to run before the state snapshot (e.g. archive before testing unarchive). */
  prepare?: FixtureStep[];
  /** Skip this operation; a string gives the reason. */
  skip?: boolean | string;
}

export type Fixtures = Record<string, Fixture>;

export interface VerifyOptions {
  spec: ApiSpec;
  baseUrl: string;
  plans?: InversePlan[];
  fixtures?: Fixtures;
  /** Fields that legitimately change on every write (timestamps, etags). */
  ignoreFields?: string[];
  /** Create one child in each sub-collection before testing, to expose cascading effects. Default true. */
  seedChildren?: boolean;
  /** Only verify these operationIds. */
  only?: string[];
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Delete every resource verify created once each operation is done. Default true. */
  cleanup?: boolean;
  /**
   * Only snapshot GET routes scoped to resources verify created (routes with path parameters).
   * Use on shared sandboxes, where global lists change under you.
   */
  scopedOnly?: boolean;
  /** When compiling plans here: also re-create child collections when undoing a delete. */
  restoreChildren?: boolean;
  onResult?: (result: OperationResult) => void;
}

/**
 * - verified:     the operation changed state and its inverse restored it
 * - failed:       state differs after the undo, or the undo could not run
 * - inconclusive: the operation changed nothing visible, so the inverse was not really tested
 * - gated:        irreversible or unknown; never executed
 * - skipped / error: by fixture, or setup/operation failed
 */
export type Outcome = 'verified' | 'failed' | 'inconclusive' | 'gated' | 'skipped' | 'error';

export interface StateDiff {
  /** The GET route whose response differed, e.g. "GET /todos/{todoId}/comments". */
  resource: string;
  /** JSON path inside the response, e.g. "$[0].done" or "status". */
  path: string;
  before: unknown;
  after: unknown;
}

export interface OperationResult {
  operationId: string;
  method: string;
  path: string;
  reversibility: Reversibility;
  strategy: Strategy;
  outcome: Outcome;
  detail: string;
  diffs: StateDiff[];
}

export interface VerifyReport {
  tool: { name: 'undogen'; version: string };
  spec: { title: string; version: string };
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  results: OperationResult[];
  summary: Record<Outcome, number> & { total: number };
}

export const DEFAULT_IGNORED_FIELDS = [
  'createdAt', 'updatedAt', 'created_at', 'updated_at', 'modifiedAt', 'modified_at',
  'lastModified', 'last_modified', 'etag', 'ETag',
];

const SNAPSHOT_MISSING = Symbol('missing');

class SetupError extends Error {}

interface Created {
  /** DELETE that removes the resource. */
  remove: RequestTemplate;
  params: Record<string, Scalar>;
}

type Scalar = string | number;

/**
 * For every mutating operation: build realistic state, snapshot it, run the
 * operation, snapshot again (it must have changed something), run its compiled
 * inverse, snapshot a third time, and diff. An inverse is "verified" only when
 * the first and last snapshots are equivalent. Everything verify created is
 * deleted afterwards.
 */
export async function verify(options: VerifyOptions): Promise<VerifyReport> {
  const startedAt = new Date().toISOString();
  const { spec } = options;
  const plans = options.plans ?? analyze(spec, { restoreChildren: options.restoreChildren }).plans;
  const planById = new Map(plans.map((p) => [p.operationId, p]));
  const opById = new Map(spec.operations.map((o) => [o.id, o]));
  const ignore = new Set(options.ignoreFields ?? DEFAULT_IGNORED_FIELDS);
  const fixtures = options.fixtures ?? {};
  const seedChildren = options.seedChildren ?? true;
  const cleanup = options.cleanup ?? true;
  const allParamNames = new Set(spec.operations.flatMap((o) => o.pathParams));
  const clientOptions = { spec, baseUrl: options.baseUrl, plans, headers: options.headers, fetch: options.fetch };

  const raw = new UndoableClient(clientOptions);
  const results: OperationResult[] = [];

  const creators = spec.operations.filter((o) => o.method === 'post' && planById.get(o.id)?.strategy === 'delete-created');
  const getters = spec.operations.filter((o) => o.method === 'get' && (!options.scopedOnly || o.pathParams.length > 0));

  /** Create a resource with `creator`, remember how to delete it, and return the new id. */
  const create = async (creator: Operation, pool: Record<string, Scalar>, created: Created[]): Promise<Scalar> => {
    const plan = planById.get(creator.id)!;
    const body = fixtures[creator.id]?.body ?? synthesize(creator.requestSchema, creator.requestExample);
    const res = await raw.request('post', fillPath(creator.path, pool), { body, contentType: creator.requestContentType });
    if (res.status >= 300) {
      throw new SetupError(`setup: ${creator.id} returned HTTP ${res.status} ${short(res.data)} — add a fixture body`);
    }
    const [param, ref] = Object.entries(plan.inverse!.bindings).find(([, b]) => b.from === 'response')!;
    const id = getPath(res.data, ref.key);
    if (id === undefined) throw new SetupError(`setup: ${creator.id} response has no "${ref.key}"`);
    created.push({ remove: plan.inverse!, params: { ...pool, [param]: id as Scalar } });
    return id as Scalar;
  };

  /** Make sure every path param of `path` refers to a real resource, creating parents first. */
  const ensure = async (path: string, pool: Record<string, Scalar>, created: Created[]) => {
    const segs = path.split('/').filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      const m = /^\{(.+)\}$/.exec(segs[i]!);
      if (!m || pool[m[1]!] !== undefined) continue;
      const collection = '/' + segs.slice(0, i).join('/');
      const creator = creators.find((c) => c.path === collection);
      if (!creator) throw new SetupError(`setup: no way to create {${m[1]}} (no POST ${collection}) — add fixture params`);
      pool[m[1]!] = await create(creator, pool, created);
    }
  };

  const snapshot = async (pool: Record<string, Scalar>) => {
    const state = new Map<string, { status: number; data: unknown }>();
    for (const g of getters) {
      if (!g.pathParams.every((p) => pool[p] !== undefined)) continue;
      const res = await raw.request('get', fillPath(g.path, pool));
      state.set(`GET ${g.path}`, { status: res.status, data: res.data });
    }
    return state;
  };

  /** Delete what verify created, newest first, following ids that undo changed. Failures are ignored. */
  const removeAll = async (created: Created[], remap: (param: string, id: Scalar) => Scalar) => {
    for (const c of [...created].reverse()) {
      try {
        const params = Object.fromEntries(Object.entries(c.params).map(([k, v]) => [k, remap(k, v)]));
        await raw.request('delete', fillPath(c.remove.path, params));
      } catch {
        /* best effort */
      }
    }
  };

  for (const op of spec.operations) {
    if (op.method === 'get') continue;
    if (options.only && !options.only.includes(op.id)) continue;
    const plan = planById.get(op.id)!;
    const fixture = fixtures[op.id] ?? {};
    const base = {
      operationId: op.id,
      method: op.method.toUpperCase(),
      path: op.path,
      reversibility: plan.reversibility,
      strategy: plan.strategy,
      diffs: [] as StateDiff[],
    };
    const record = (outcome: Outcome, detail: string, diffs: StateDiff[] = []) => {
      const r = { ...base, outcome, detail, diffs };
      results.push(r);
      options.onResult?.(r);
    };

    if (fixture.skip) {
      record('skipped', typeof fixture.skip === 'string' ? fixture.skip : 'skipped by fixture');
      continue;
    }
    if (plan.reversibility === 'irreversible' || plan.reversibility === 'unknown') {
      record('gated', 'never executed; blocked at runtime unless approved');
      continue;
    }

    const created: Created[] = [];
    const client = new UndoableClient(clientOptions);
    try {
      // 1. Arrange: real resources for every path param, plus children to expose cascades.
      const pool: Record<string, Scalar> = { ...(fixture.params ?? {}) };
      await ensure(op.path, pool, created);
      const root = itemRootOf(op.path);
      if (seedChildren && root) {
        for (const c of creators) {
          if (!c.path.startsWith(root + '/')) continue;
          if (!c.pathParams.every((p) => pool[p] !== undefined)) continue;
          const child = childParamOf(c.path, spec);
          if (child && pool[child] === undefined) pool[child] = await create(c, pool, created);
        }
      }
      for (const step of fixture.prepare ?? []) {
        const stepOp = opById.get(step.operationId);
        if (!stepOp) throw new SetupError(`fixture: unknown operation ${step.operationId}`);
        const res = await raw.request(stepOp.method, fillPath(stepOp.path, { ...pool, ...step.params }), {
          body: step.body,
          contentType: stepOp.requestContentType,
        });
        if (res.status >= 400) throw new SetupError(`fixture step ${step.operationId} returned HTTP ${res.status}`);
      }

      // 2. Snapshot, act, snapshot, undo, snapshot.
      const before = await snapshot(pool);
      const current = before.get(`GET ${op.path}`)?.data;
      const body = fixture.body ?? bodyFor(op, current);
      const input: CallInput = { params: pick(pool, op.pathParams), body };
      const res = await client.call(op.id, input);
      if (res.status >= 400) {
        record('error', `operation returned HTTP ${res.status} ${short(res.data)} — add a fixture`);
        continue;
      }
      const entry = res.entry!;
      // Probe what the operation created, so creates are tested even without a list route.
      const probe = entry.created && entry.inverse?.pathTemplate ? { template: entry.inverse.pathTemplate, params: entry.inverse.params ?? {} } : undefined;
      const probeState = async () => (probe ? (await raw.request('get', fillPath(probe.template, probe.params))).status : undefined);
      const mid = await snapshot(pool);
      const midProbe = await probeState();
      const changed = diffStates(before, mid, { ignore }).length > 0 || (midProbe !== undefined && midProbe < 300);

      if (!entry.inverse && plan.strategy !== 'no-side-effects') {
        record('failed', `could not build the inverse: ${entry.inverseError ?? 'unknown reason'}`);
        continue;
      }
      let undo: HttpResult;
      try {
        undo = await client.undo(entry);
      } catch (err) {
        record('failed', `inverse request failed: ${(err as Error).message}`);
        continue;
      }
      void undo;

      // Compensable inverses re-create resources under new ids: follow them.
      const afterPool = Object.fromEntries(Object.entries(pool).map(([k, v]) => [k, client.remapId(k, v)]));
      const identityChanged = Object.keys(entry.idMap ?? {}).length > 0;
      const after = await snapshot(afterPool);

      const diffs = diffStates(before, after, {
        ignore,
        identityKeys: identityChanged ? new Set(['id', ...allParamNames]) : undefined,
      });
      const afterProbe = await probeState();
      if (afterProbe !== undefined && afterProbe < 300) {
        diffs.push({ resource: `GET ${probe!.template}`, path: 'status', before: 404, after: afterProbe });
      }
      if (diffs.length) {
        record('failed', `${diffs.length} difference(s) remain after undo`, diffs);
      } else if (!changed && plan.strategy !== 'no-side-effects') {
        record('inconclusive', 'the operation changed no visible state, so its inverse was not exercised — add a fixture body');
      } else if (identityChanged) {
        const n = Object.values(entry.idMap ?? {}).reduce((sum, m) => sum + Object.keys(m).length, 0);
        record('verified', n > 1 ? `state restored (${n} resources re-created under new ids)` : 'state restored (resource re-created under a new id)');
      } else {
        record('verified', 'state restored exactly');
      }
    } catch (err) {
      record('error', (err as Error).message);
    } finally {
      if (cleanup) {
        const leftovers = client.journal.filter((e) => e.status !== 'undone' && e.created && e.inverse?.pathTemplate);
        for (const e of leftovers) created.push({ remove: { ...planById.get(e.operationId)!.inverse!, path: e.inverse!.pathTemplate! }, params: e.inverse!.params ?? {} });
        await removeAll(created, (k, v) => client.remapId(k, v));
      }
    }
  }

  const summary = { verified: 0, failed: 0, inconclusive: 0, gated: 0, skipped: 0, error: 0, total: results.length };
  for (const r of results) summary[r.outcome]++;
  return {
    tool: { name: 'undogen', version: VERSION },
    spec: { title: spec.title, version: spec.version },
    baseUrl: options.baseUrl,
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
    summary,
  };
}

function parentOf(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

/** The item an operation acts on: /todos/{id} for /todos/{id}, /todos/{id}/archive and /todos/{id}/comments. */
function itemRootOf(path: string): string | undefined {
  if (/\{[^}]+\}$/.test(path)) return path;
  const parent = parentOf(path);
  return /\{[^}]+\}$/.test(parent) ? parent : undefined;
}

function childParamOf(collectionPath: string, spec: ApiSpec): string | undefined {
  const item = spec.operations.find((o) => parentOf(o.path) === collectionPath && /\{[^}]+\}$/.test(o.path));
  return item?.pathParams.at(-1);
}

function pick<T>(obj: Record<string, T>, keys: string[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k]!;
  return out;
}

function short(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 120 ? s.slice(0, 117) + '...' : s ?? '';
}

/** Build a request body that actually changes the current state, so a no-op can't pass as "verified". */
function bodyFor(op: Operation, current: unknown): unknown {
  if (!op.requestSchema && op.requestExample === undefined) return undefined;
  if ((op.method === 'patch' || op.method === 'put') && current && typeof current === 'object') {
    const props = op.requestSchema?.properties ?? {};
    const out: Record<string, unknown> = {};
    const required = new Set(op.requestSchema?.required ?? []);
    for (const [name, schema] of Object.entries(props)) {
      if (schema?.readOnly) continue;
      const cur = (current as Record<string, unknown>)[name];
      const changed = mutate(cur, schema);
      if (changed !== undefined) out[name] = changed;
      else if (required.has(name) || op.method === 'put') out[name] = synthesizeValue(name, schema);
    }
    return out;
  }
  return synthesize(op.requestSchema, op.requestExample);
}

function mutate(value: unknown, schema: Schema): unknown {
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'string') {
    if (Array.isArray(schema.enum)) return schema.enum.find((e) => e !== value) ?? value;
    if (schema.format) return undefined; // dates, emails, uuids: don't produce invalid values
    return `${value} (undogen)`;
  }
  return undefined;
}

/** Produce an example request body from a schema. */
export function synthesize(schema: Schema | undefined, example?: unknown): unknown {
  if (example !== undefined) return example;
  if (!schema) return undefined;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  // oneOf / anyOf: build one valid variant rather than a mix of all of them.
  const variants = schema['x-undogen-variants'] as Schema[] | undefined;
  if (variants?.length) return synthesize(variants.find((v) => v.properties) ?? variants[0]);
  if (schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [name, s] of Object.entries(schema.properties)) {
      if (s?.readOnly) continue;
      out[name] = synthesizeValue(name, s);
    }
    return out;
  }
  return synthesizeValue('value', schema);
}

function synthesizeValue(name: string, s: Schema): unknown {
  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum.find((e) => e !== null) ?? s.enum[0];
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  switch (type) {
    case 'string':
      if (s.format === 'email') return 'undogen@example.com';
      if (s.format === 'date-time') return new Date(0).toISOString();
      if (s.format === 'date') return '1970-01-01';
      if (s.format === 'uri') return 'https://example.com';
      return `undogen-${name}`;
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return s.properties ? synthesize(s) : {};
    default:
      return s.properties ? synthesize(s) : `undogen-${name}`;
  }
}

type State = Map<string, { status: number; data: unknown }>;

/** Compare two snapshots and return every leaf-level difference. */
export function diffStates(
  before: State,
  after: State,
  opts: { ignore: Set<string>; identityKeys?: Set<string> },
): StateDiff[] {
  const diffs: StateDiff[] = [];
  for (const [resource, b] of before) {
    const a = after.get(resource);
    if (!a) continue;
    if (b.status !== a.status) {
      diffs.push({ resource, path: 'status', before: b.status, after: a.status });
      continue;
    }
    deepDiff(normalize(b.data, opts), normalize(a.data, opts), '$', (path, x, y) =>
      diffs.push({ resource, path, before: x, after: y }),
    );
  }
  return diffs;
}

function normalize(value: unknown, opts: { ignore: Set<string>; identityKeys?: Set<string> }): unknown {
  if (Array.isArray(value)) {
    const items = value.map((v) => normalize(v, opts));
    // Without stable identities, order is meaningless: compare as a multiset.
    return opts.identityKeys ? items.sort((x, y) => stable(x).localeCompare(stable(y))) : items;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (opts.ignore.has(k) || opts.identityKeys?.has(k)) continue;
      out[k] = normalize(v, opts);
    }
    return out;
  }
  return value;
}

function stable(v: unknown): string {
  return JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x,
  );
}

function deepDiff(a: unknown, b: unknown, path: string, emit: (p: string, a: unknown, b: unknown) => void): void {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      deepDiff(i < a.length ? a[i] : SNAPSHOT_MISSING, i < b.length ? b[i] : SNAPSHOT_MISSING, `${path}[${i}]`, emit);
    }
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const ao = a as Record<string, unknown>;
      const bo = b as Record<string, unknown>;
      deepDiff(k in ao ? ao[k] : SNAPSHOT_MISSING, k in bo ? bo[k] : SNAPSHOT_MISSING, `${path}.${k}`, emit);
    }
    return;
  }
  if (stable(a) !== stable(b)) {
    emit(path, a === SNAPSHOT_MISSING ? undefined : a, b === SNAPSHOT_MISSING ? undefined : b);
  }
}
