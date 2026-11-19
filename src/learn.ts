import { analyze } from './analyze.js';
import { fillPath, idFromLocation, UndoableClient } from './runtime.js';
import type { ApiSpec, Declaration, InversePlan } from './types.js';
import { arranger, synthesize, type Created, type Fixtures } from './verify.js';

export interface LearnOptions {
  spec: ApiSpec;
  baseUrl: string;
  plans?: InversePlan[];
  fixtures?: Fixtures;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Only try these operationIds. */
  only?: string[];
  onAttempt?: (attempt: LearnAttempt) => void;
}

export interface LearnAttempt {
  operationId: string;
  outcome: 'learned' | 'not-learned' | 'error';
  detail: string;
  declaration?: Declaration;
}

export interface LearnResult {
  /** Overrides to merge into an overrides file, keyed by operationId. */
  learned: Record<string, Declaration>;
  attempts: LearnAttempt[];
}

/** Field names that usually carry an identifier, best first. */
const ID_HINTS = ['id', 'uuid', 'key', 'number', 'slug', 'name', 'ref', 'code', 'handle'];

/**
 * Turn `unknown` creates into declared ones by experiment. For every create
 * whose inverse the analyzer suspects but cannot bind (the response does not
 * name the new resource's id), learn creates a resource and tries each
 * candidate value (the Location header, then response fields that look like
 * ids) against the item's GET route. The first candidate that reads the
 * resource back, and whose DELETE then makes it disappear, is learned.
 *
 * Learned bindings are hypotheses too: run `undogen verify` with them.
 */
export async function learn(options: LearnOptions): Promise<LearnResult> {
  const { spec } = options;
  const plans = options.plans ?? analyze(spec).plans;
  const planById = new Map(plans.map((p) => [p.operationId, p]));
  const opById = new Map(spec.operations.map((o) => [o.id, o]));
  const fixtures = options.fixtures ?? {};
  const raw = new UndoableClient({ spec, baseUrl: options.baseUrl, plans, headers: options.headers, fetch: options.fetch });
  const { ensure, removeAll } = arranger(raw, spec, planById, fixtures);
  const learned: Record<string, Declaration> = {};
  const attempts: LearnAttempt[] = [];
  const note = (a: LearnAttempt) => {
    attempts.push(a);
    options.onAttempt?.(a);
  };

  for (const plan of plans) {
    if (!plan.suggestion || plan.reversibility !== 'unknown') continue;
    if (options.only && !options.only.includes(plan.operationId)) continue;
    const op = opById.get(plan.operationId)!;
    const del = opById.get(plan.suggestion.inverse);
    if (!del) continue;
    const get = spec.operations.find((o) => o.method === 'get' && o.path === del.path);
    const param = plan.suggestion.param;
    if (!get) {
      note({ operationId: op.id, outcome: 'not-learned', detail: `no GET ${del.path} to confirm a candidate id with` });
      continue;
    }
    const missing = del.pathParams.filter((p) => p !== param && !op.pathParams.includes(p));
    if (missing.length) {
      note({ operationId: op.id, outcome: 'not-learned', detail: `${del.id} needs {${missing.join('}, {')}}, which the create does not have` });
      continue;
    }

    const created: Created[] = [];
    try {
      const pool: Record<string, string | number> = { ...(fixtures[op.id]?.params ?? {}) };
      await ensure(op.path, pool, created);
      const body = fixtures[op.id]?.body ?? synthesize(op.requestSchema, op.requestExample);
      const res = await raw.request('post', fillPath(op.path, pool), { body, contentType: op.requestContentType });
      if (res.status >= 300) {
        note({ operationId: op.id, outcome: 'error', detail: `${op.id} returned HTTP ${res.status} — add a fixture body` });
        continue;
      }

      const candidates = candidateIds(res.data, res.headers['location']);
      let found: { binding: string; value: string | number } | undefined;
      for (const c of candidates) {
        const check = await raw.request('get', fillPath(get.path, { ...pool, [param]: c.value }));
        if (check.status < 300) {
          found = c;
          break;
        }
      }
      if (!found) {
        note({
          operationId: op.id,
          outcome: 'not-learned',
          detail: `none of ${candidates.length} candidate value(s) read the new resource back; the resource it created is left in the sandbox (no id to delete it by)`,
        });
        continue;
      }
      const params = { ...pool, [param]: found.value };
      const removed = await raw.request('delete', fillPath(del.path, params));
      const gone = await raw.request('get', fillPath(get.path, params));
      if (removed.status >= 300 || (gone.status !== 404 && gone.status !== 410)) {
        created.push({ remove: { operationId: del.id, method: 'delete', path: del.path, bindings: {} }, params });
        note({
          operationId: op.id,
          outcome: 'not-learned',
          detail: `${del.id} with ${param} ← ${found.binding} did not remove the resource (DELETE ${removed.status}, then GET ${gone.status})`,
        });
        continue;
      }
      const declaration: Declaration = {
        inverse: del.id,
        bindings: { [param]: found.binding },
        reason: `Learned by undogen learn: ${found.binding} identifies the created resource for ${del.id}`,
      };
      learned[op.id] = declaration;
      note({ operationId: op.id, outcome: 'learned', detail: `${param} ← ${found.binding}`, declaration });
    } catch (err) {
      note({ operationId: op.id, outcome: 'error', detail: (err as Error).message });
    } finally {
      await removeAll(created);
    }
  }
  return { learned, attempts };
}

/** Values in a create response that might identify the new resource, most likely first. */
export function candidateIds(data: unknown, location?: string): Array<{ binding: string; value: string | number }> {
  const out: Array<{ binding: string; value: string | number; score: number }> = [];
  if (location) {
    const id = idFromLocation(location);
    if (id) out.push({ binding: 'location', value: id, score: -1 });
  }
  const walk = (node: unknown, prefix: string, depth: number) => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 2) return;
    for (const [k, v] of Object.entries(node)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string' || typeof v === 'number') {
        const hint = ID_HINTS.findIndex((h) => k.toLowerCase() === h || k.toLowerCase().endsWith(h) || k.toLowerCase().endsWith(`_${h}`));
        out.push({ binding: `response.${key}`, value: v, score: (hint === -1 ? 100 : hint) + depth * 10 });
      } else walk(v, key, depth + 1);
    }
  };
  walk(data, '', 0);
  const seen = new Set<string>();
  return out
    .sort((a, b) => a.score - b.score)
    .filter((c) => {
      if (typeof c.value === 'string' && (c.value.length === 0 || c.value.length > 200 || /\s/.test(c.value))) return false;
      const k = `${c.binding}=${c.value}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map(({ binding, value }) => ({ binding, value }));
}
