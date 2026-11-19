import { analyze } from './analyze.js';
import { ConflictError, fillPath, getPath, UndoableClient, VOLATILE_FIELDS, type CallInput, type HttpResult } from './runtime.js';
import type { ApiSpec, InversePlan, Operation, RequestTemplate, Reversibility, Schema, Strategy } from './types.js';
import { structuralPath } from './spec.js';
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
  /**
   * Also prove the conflict check: repeat each verified operation, let "someone else" change
   * what it wrote, and require the undo to refuse. Doubles the requests made.
   */
  checkConflicts?: boolean;
  /** Parallel GETs per snapshot. Default 4. */
  concurrency?: number;
  /** Pages to follow (Link: rel="next") when a GET returns a list. Default 5; 1 disables. */
  maxPages?: number;
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
  /**
   * With checkConflicts: whether the runtime refused to undo over a simulated concurrent change.
   * 'missed' makes the outcome 'failed'.
   */
  conflictCheck?: { result: 'caught' | 'missed' | 'not-applicable'; detail: string };
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

export const DEFAULT_IGNORED_FIELDS = [...VOLATILE_FIELDS];

const SNAPSHOT_MISSING = Symbol('missing');

class SetupError extends Error {}

export interface Created {
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

  const { creators, create, ensure, removeAll } = arranger(raw, spec, planById, fixtures);
  const getters = spec.operations.filter((o) => o.method === 'get' && (!options.scopedOnly || o.pathParams.length > 0));

  const maxPages = options.maxPages ?? 5;
  /** GET a route, following Link: rel="next" for lists so changes past the first page are seen. */
  const readAll = async (path: string) => {
    const first = await raw.request('get', path);
    if (!Array.isArray(first.data) || maxPages <= 1) return { status: first.status, data: first.data };
    const items = [...first.data];
    let next = nextLink(first.headers['link'], options.baseUrl);
    for (let page = 1; next && page < maxPages; page++) {
      const res = await raw.request('get', next);
      if (res.status >= 300 || !Array.isArray(res.data)) break;
      items.push(...res.data);
      next = nextLink(res.headers['link'], options.baseUrl);
    }
    return { status: first.status, data: items };
  };

  const snapshot = async (pool: Record<string, Scalar>) => {
    const state = new Map<string, { status: number; data: unknown }>();
    const due = getters.filter((g) => g.pathParams.every((p) => pool[p] !== undefined));
    const results = await mapLimit(due, options.concurrency ?? 4, (g) => readAll(fillPath(g.path, pool)));
    due.forEach((g, i) => state.set(`GET ${g.path}`, results[i]!));
    return state;
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
    const record = (outcome: Outcome, detail: string, diffs: StateDiff[] = [], conflictCheck?: OperationResult['conflictCheck']) => {
      const r: OperationResult = { ...base, outcome, detail, diffs, ...(conflictCheck ? { conflictCheck } : {}) };
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
    /** Real resources for every path param, plus children to expose cascades, plus fixture prepare steps. */
    const arrange = async (): Promise<Record<string, Scalar>> => {
      const pool: Record<string, Scalar> = { ...(fixture.params ?? {}) };
      await ensure(op.path, pool, created);
      const root = itemRootOf(structuralPath(op.path));
      if (seedChildren && root) {
        for (const c of creators) {
          if (!structuralPath(c.path).startsWith(root + '/')) continue;
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
      return pool;
    };
    const probeClients: UndoableClient[] = [];
    const probeConflict = async (): Promise<NonNullable<OperationResult['conflictCheck']>> => {
      const na = (detail: string) => ({ result: 'not-applicable' as const, detail });
      const pool = await arrange();
      const current = (await raw.request('get', fillPath(op.path, pool)).catch(() => undefined))?.data;
      const c = new UndoableClient(clientOptions);
      probeClients.push(c);
      const res = await c.call(op.id, { params: pick(pool, op.pathParams), body: fixture.body ?? bodyFor(op, current) });
      const e = res.entry;
      if (res.status >= 400 || !e?.inverse) return na('could not repeat the operation');
      if (!e.check || e.noop) return na('nothing to check: the operation leaves no readable state');
      let what: string;
      if (e.check.mode === 'diff') {
        // For an action, "someone else" reverses it.
        const r = await raw.request(e.inverse.method, e.inverse.path, { body: e.inverse.body, contentType: e.inverse.contentType });
        if (r.status >= 400) return na(`could not simulate a concurrent change: ${e.inverse.operationId} returned HTTP ${r.status}`);
        what = `someone else ran ${e.inverse.operationId}`;
      } else {
        const checkPath = fillPath(e.check.pathTemplate, e.check.params);
        const writers = spec.operations.filter((o) => (o.method === 'patch' || o.method === 'put') && structuralPath(o.path) === structuralPath(e.check!.pathTemplate));
        const writer = writers.find((o) => o.method === 'patch') ?? writers[0];
        const change = mutateExpected(e.check.expected);
        if (!writer) return na(`no PATCH or PUT on ${e.check.pathTemplate} to simulate a concurrent change with`);
        if (!change) return na('no field it wrote can be changed safely');
        let body: unknown = change.body;
        if (writer.method === 'put') {
          const now = await raw.request('get', checkPath);
          body = deepAssign(structuredClone(now.data ?? {}), change.body);
        }
        const r = await raw.request(writer.method, checkPath, { body, contentType: writer.requestContentType });
        if (r.status >= 400) return na(`could not simulate a concurrent change: ${writer.id} returned HTTP ${r.status}`);
        what = `someone else changed ${change.field} through ${writer.id}`;
      }
      try {
        await c.undo(e);
        return { result: 'missed', detail: what };
      } catch (err) {
        if (err instanceof ConflictError) return { result: 'caught', detail: what };
        return na(`the undo failed for another reason: ${(err as Error).message}`);
      }
    };
    try {
      // 1. Arrange.
      const pool = await arrange();

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
      } else {
        const n = Object.values(entry.idMap ?? {}).reduce((sum, m) => sum + Object.keys(m).length, 0);
        const detail = !identityChanged
          ? 'state restored exactly'
          : n > 1
            ? `state restored (${n} resources re-created under new ids)`
            : 'state restored (resource re-created under a new id)';
        if (!options.checkConflicts) {
          record('verified', detail);
        } else {
          // 3. Prove the conflict check: run it again, let "someone else" change what it wrote, and expect the undo to refuse.
          const check = await probeConflict();
          if (check.result === 'missed') record('failed', `${detail}, but the undo overwrote a concurrent change (${check.detail})`, [], check);
          else record('verified', check.result === 'caught' ? `${detail}; refused to overwrite a concurrent change` : detail, [], check);
        }
      }
    } catch (err) {
      record('error', (err as Error).message);
    } finally {
      if (cleanup) {
        const leftovers = [client, ...probeClients].flatMap((x) => x.journal).filter((e) => e.status !== 'undone' && e.created && e.inverse?.pathTemplate);
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

/** Creates real resources for path parameters (parents first) and deletes them again. Shared by verify and learn. */
export function arranger(raw: UndoableClient, spec: ApiSpec, planById: Map<string, InversePlan>, fixtures: Fixtures) {
  const creators = spec.operations.filter((o) => o.method === 'post' && planById.get(o.id)?.strategy === 'delete-created');

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
    const segs = structuralPath(path).split('/').filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      const m = /^\{(.+)\}$/.exec(segs[i]!);
      if (!m || pool[m[1]!] !== undefined) continue;
      const collection = '/' + segs.slice(0, i).join('/');
      const creator = creators.find((c) => structuralPath(c.path) === structuralPath(collection));
      if (!creator) throw new SetupError(`setup: no way to create {${m[1]}} (no POST ${collection}) — add fixture params`);
      pool[m[1]!] = await create(creator, pool, created);
    }
  };

  /** Delete what was created, newest first, following ids that undo changed. Failures are ignored. */
  const removeAll = async (created: Created[], remap: (param: string, id: Scalar) => Scalar = (_, v) => v) => {
    for (const c of [...created].reverse()) {
      try {
        const params = Object.fromEntries(Object.entries(c.params).map(([k, v]) => [k, remap(k, v)]));
        await raw.request('delete', fillPath(c.remove.path, params));
      } catch {
        /* best effort */
      }
    }
  };

  return { creators, create, ensure, removeAll };
}

/** The path + query of a Link header's rel="next" target, if it points at the same API. */
export function nextLink(header: string | undefined, baseUrl: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;(.*)/.exec(part.trim());
    if (!m || !/rel="?([^";]*\s)?next(\s[^";]*)?"?/i.test(m[2]!)) continue;
    const base = new URL(baseUrl.replace(/\/?$/, '/'));
    const url = new URL(m[1]!, base);
    if (url.origin !== base.origin) return undefined;
    const prefix = base.pathname.replace(/\/$/, '');
    if (!url.pathname.startsWith(prefix)) return undefined;
    return url.pathname.slice(prefix.length) + url.search;
  }
  return undefined;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** A change to one field the call wrote (following nested objects), as a body that sets it. */
function mutateExpected(expected: Record<string, unknown>): { body: Record<string, unknown>; field: string } | undefined {
  for (const [k, v] of Object.entries(expected)) {
    if (k === '(status)') continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = mutateExpected(v as Record<string, unknown>);
      if (inner) return { body: { [k]: inner.body }, field: `${k}.${inner.field}` };
      continue;
    }
    const changed =
      typeof v === 'string' ? `${v} (changed by someone else)` : typeof v === 'number' ? v + 1 : typeof v === 'boolean' ? !v : undefined;
    if (changed !== undefined) return { body: { [k]: changed }, field: k };
  }
  return undefined;
}

function deepAssign(target: unknown, patch: Record<string, unknown>): unknown {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return patch;
  const t = target as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    t[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepAssign(t[k], v as Record<string, unknown>) : v;
  }
  return t;
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
  const target = structuralPath(collectionPath);
  const item = spec.operations.find((o) => parentOf(structuralPath(o.path)) === target && /\{[^}]+\}$/.test(structuralPath(o.path)));
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

/** A different value for a field that still satisfies its schema, or undefined if we can't make one. */
function mutate(value: unknown, schema: Schema): unknown {
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') {
    const max = typeof schema.maximum === 'number' ? schema.maximum : Infinity;
    const step = typeof schema.multipleOf === 'number' ? schema.multipleOf : 1;
    if (value + step <= max) return value + step;
    const min = typeof schema.minimum === 'number' ? schema.minimum : -Infinity;
    return value - step >= min ? value - step : undefined;
  }
  if (typeof value === 'string') {
    if (Array.isArray(schema.enum)) return schema.enum.find((e) => e !== value) ?? value;
    if (schema.format) return undefined; // dates, emails, uuids: don't produce invalid values
    const appended = `${value} (undogen)`;
    const maxLength = typeof schema.maxLength === 'number' ? schema.maxLength : Infinity;
    const fits = (v: string) => v.length <= maxLength && (typeof schema.pattern !== 'string' || safeTest(schema.pattern, v));
    if (fits(appended)) return appended;
    const other = synthesizeString('value', schema);
    return other !== value && fits(other) ? other : undefined;
  }
  return undefined;
}

function safeTest(pattern: string, v: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(v);
  } catch {
    return true;
  }
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

const FORMAT_VALUES: Record<string, string> = {
  email: 'undogen@example.com',
  'date-time': new Date(0).toISOString(),
  date: '1970-01-01',
  time: '00:00:00Z',
  uri: 'https://example.com',
  url: 'https://example.com',
  'uri-reference': '/undogen',
  uuid: '00000000-0000-4000-8000-000000000000',
  ipv4: '192.0.2.1',
  ipv6: '2001:db8::1',
  hostname: 'example.com',
  byte: 'dW5kb2dlbg==',
  password: 'Undogen-pa55word!',
  'phone-number': '+15555550100',
};

/** A string that satisfies the schema's format, pattern and length constraints, as far as we can tell. */
function synthesizeString(name: string, s: Schema): string {
  const fitLength = (v: string) => {
    const min = typeof s.minLength === 'number' ? s.minLength : 0;
    const max = typeof s.maxLength === 'number' ? s.maxLength : Infinity;
    let out = v;
    while (out.length < min) out += 'x';
    return out.length > max ? out.slice(0, max) : out;
  };
  if (s.format && FORMAT_VALUES[s.format]) return FORMAT_VALUES[s.format]!;
  const preferred = fitLength(`undogen-${name}`);
  if (typeof s.pattern !== 'string') return preferred;
  let re: RegExp;
  try {
    re = new RegExp(s.pattern as string, 'u');
  } catch {
    return preferred;
  }
  const candidates = [preferred, fitLength('undogen'), fitLength(name), 'abc', 'ABC', 'a1', 'A1', '1', '123', 'abc-123', 'abc_123', 'a.b', 'undogen@example.com', '#ffffff', 'ffffff', '2024-01-01', 'US', 'en', 'en-US'];
  return candidates.find((c) => re.test(c)) ?? preferred;
}

function synthesizeNumber(s: Schema, integer: boolean): number {
  const min = typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum : undefined;
  const max = typeof s.maximum === 'number' ? s.maximum : typeof s.exclusiveMaximum === 'number' ? s.exclusiveMaximum : undefined;
  let v = 1;
  if (min !== undefined && v <= min) v = min + (s.exclusiveMinimum === true || typeof s.exclusiveMinimum === 'number' ? 1 : 0);
  if (max !== undefined && v >= max) v = max - (s.exclusiveMaximum === true || typeof s.exclusiveMaximum === 'number' ? 1 : 0);
  if (typeof s.multipleOf === 'number' && s.multipleOf > 0) v = Math.ceil(v / s.multipleOf) * s.multipleOf;
  return integer ? Math.round(v) : v;
}

function synthesizeValue(name: string, s: Schema): unknown {
  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (s.const !== undefined) return s.const;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum.find((e) => e !== null) ?? s.enum[0];
  const variants = s['x-undogen-variants'] as Schema[] | undefined;
  if (variants?.length) return synthesize(variants.find((v) => v.properties) ?? variants[0]);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  switch (type) {
    case 'string':
      return synthesizeString(name, s);
    case 'integer':
      return synthesizeNumber(s, true);
    case 'number':
      return synthesizeNumber(s, false);
    case 'boolean':
      return false;
    case 'array': {
      const n = typeof s.minItems === 'number' ? s.minItems : 0;
      return Array.from({ length: n }, () => synthesizeValue(name.replace(/s$/, ''), (s.items as Schema) ?? {}));
    }
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
