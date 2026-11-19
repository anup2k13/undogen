import { analyze } from './analyze.js';
import { DEFAULT_IGNORED_FIELDS, diffStates, type StateDiff } from './diff.js';
import { fillPath, getPath, UndoableClient, type CallInput, type HttpResult } from './runtime.js';
import type { ApiSpec, InversePlan, Operation, Reversibility, Schema, Strategy } from './types.js';

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
  onResult?: (result: OperationResult) => void;
}

export type Outcome = 'verified' | 'failed' | 'gated' | 'skipped' | 'error';

export type { StateDiff } from './diff.js';

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

export { DEFAULT_IGNORED_FIELDS } from './diff.js';

class SetupError extends Error {}

/**
 * For every mutating operation: build realistic state, snapshot it, run the
 * operation, run its compiled inverse, snapshot again, and diff.
 * An inverse is "verified" only when the two snapshots are equivalent.
 */
export async function verify(options: VerifyOptions): Promise<VerifyReport> {
  const startedAt = new Date().toISOString();
  const { spec } = options;
  const plans = options.plans ?? analyze(spec).plans;
  const planById = new Map(plans.map((p) => [p.operationId, p]));
  const opById = new Map(spec.operations.map((o) => [o.id, o]));
  const ignore = new Set(options.ignoreFields ?? DEFAULT_IGNORED_FIELDS);
  const fixtures = options.fixtures ?? {};
  const seedChildren = options.seedChildren ?? true;
  const allParamNames = new Set(spec.operations.flatMap((o) => o.pathParams));

  const raw = new UndoableClient({ spec, baseUrl: options.baseUrl, plans, headers: options.headers, fetch: options.fetch });
  const results: OperationResult[] = [];

  const creators = spec.operations.filter((o) => o.method === 'post' && planById.get(o.id)?.strategy === 'delete-created');
  const getters = spec.operations.filter((o) => o.method === 'get');

  /** Create a resource with `creator` and return the new id. */
  const create = async (creator: Operation, pool: Record<string, string | number>): Promise<string | number> => {
    const plan = planById.get(creator.id)!;
    const body = fixtures[creator.id]?.body ?? synthesize(creator.requestSchema, creator.requestExample);
    const res = await raw.request('post', fillPath(creator.path, pool), { body });
    if (res.status >= 300) {
      throw new SetupError(`setup: ${creator.id} returned HTTP ${res.status} ${short(res.data)} — add a fixture body`);
    }
    const ref = Object.values(plan.inverse!.bindings).find((b) => b.from === 'response')!;
    const id = getPath(res.data, ref.key);
    if (id === undefined) throw new SetupError(`setup: ${creator.id} response has no "${ref.key}"`);
    return id as string | number;
  };

  /** Make sure every path param of `path` refers to a real resource, creating parents first. */
  const ensure = async (path: string, pool: Record<string, string | number>) => {
    const segs = path.split('/').filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      const m = /^\{(.+)\}$/.exec(segs[i]!);
      if (!m || pool[m[1]!] !== undefined) continue;
      const collection = '/' + segs.slice(0, i).join('/');
      const creator = creators.find((c) => c.path === collection);
      if (!creator) throw new SetupError(`setup: no way to create {${m[1]}} (no POST ${collection}) — add fixture params`);
      pool[m[1]!] = await create(creator, pool);
    }
  };

  const snapshot = async (pool: Record<string, string | number>) => {
    const state = new Map<string, { status: number; data: unknown }>();
    for (const g of getters) {
      if (!g.pathParams.every((p) => pool[p] !== undefined)) continue;
      const res = await raw.request('get', fillPath(g.path, pool));
      state.set(`GET ${g.path}`, { status: res.status, data: res.data });
    }
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

    try {
      // 1. Arrange: real resources for every path param, plus children to expose cascades.
      const pool: Record<string, string | number> = { ...(fixture.params ?? {}) };
      await ensure(op.path, pool);
      const root = itemRootOf(op.path);
      if (seedChildren && root) {
        for (const c of creators) {
          if (!c.path.startsWith(root + '/')) continue;
          if (!c.pathParams.every((p) => pool[p] !== undefined)) continue;
          const child = childParamOf(c.path, spec);
          if (child && pool[child] === undefined) pool[child] = await create(c, pool);
        }
      }
      for (const step of fixture.prepare ?? []) {
        const stepOp = opById.get(step.operationId);
        if (!stepOp) throw new SetupError(`fixture: unknown operation ${step.operationId}`);
        const res = await raw.request(stepOp.method, fillPath(stepOp.path, { ...pool, ...step.params }), { body: step.body });
        if (res.status >= 400) throw new SetupError(`fixture step ${step.operationId} returned HTTP ${res.status}`);
      }

      // 2. Snapshot, act, undo, snapshot.
      const before = await snapshot(pool);
      const client = new UndoableClient({ spec, baseUrl: options.baseUrl, plans, headers: options.headers, fetch: options.fetch });
      const current = before.get(`GET ${op.path}`)?.data;
      const body = fixture.body ?? bodyFor(op, current);
      const input: CallInput = { params: pick(pool, op.pathParams), body };
      const res = await client.call(op.id, input);
      if (res.status >= 400) {
        record('error', `operation returned HTTP ${res.status} ${short(res.data)} — add a fixture`);
        continue;
      }
      if (!res.entry || (!res.entry.inverse && plan.strategy !== 'no-side-effects')) {
        record('failed', `could not build the inverse: ${res.entry?.inverseError ?? 'unknown reason'}`);
        continue;
      }
      let undo: HttpResult;
      try {
        undo = await client.undo(res.entry);
      } catch (err) {
        record('failed', `inverse request failed: ${(err as Error).message}`);
        continue;
      }

      // Compensable inverses re-create resources under new ids: follow the new id.
      const afterPool = { ...pool };
      const identityChanged = plan.strategy === 'recreate-from-snapshot' && res.entry.inverse?.method === 'post';
      if (identityChanged) {
        const param = op.pathParams[op.pathParams.length - 1]!;
        const newId = getPath(undo.data, param) ?? getPath(undo.data, 'id');
        if (newId !== undefined) afterPool[param] = newId as string | number;
      }
      const after = await snapshot(afterPool);

      const diffs = diffStates(before, after, {
        ignore,
        identityKeys: identityChanged ? new Set(['id', ...allParamNames]) : undefined,
      });
      if (diffs.length === 0) {
        record('verified', identityChanged ? 'state restored (resource re-created under a new id)' : 'state restored exactly');
      } else {
        record('failed', `${diffs.length} difference(s) remain after undo`, diffs);
      }
    } catch (err) {
      record('error', (err as Error).message);
    }
  }

  const summary = { verified: 0, failed: 0, gated: 0, skipped: 0, error: 0, total: results.length };
  for (const r of results) summary[r.outcome]++;
  return {
    tool: { name: 'undogen', version: '0.1.0' },
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
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
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
