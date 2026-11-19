import type { Analysis, ApiSpec, Declaration } from './types.js';
import { synthesize, type Fixture, type Fixtures, type VerifyReport } from './verify.js';

/** Action names that only make sense after their counterpart ran (unarchive needs an archived item). */
const SECOND_OF_PAIR = /^(un|de|dis)|^(close|stop|resume|show|remove|detach|unlock)$/i;

export interface InitResult {
  overrides: Record<string, Declaration>;
  fixtures: Fixtures;
}

/**
 * Starter overrides and fixtures for whatever undogen could not figure out
 * on its own. Every entry carries `_`-prefixed notes; undogen ignores those
 * keys, so the files are valid as generated and you fill in what's missing.
 *
 * - overrides: one entry per `unknown` operation, with its reason and likely inverse candidates
 * - fixtures:  `prepare` steps for paired actions (unarchive runs archive first), and,
 *              given a verify report, a body template for each operation that errored or was inconclusive
 */
export function initFiles(spec: ApiSpec, analysis: Analysis, report?: VerifyReport): InitResult {
  const overrides: Record<string, Declaration> = {};
  const fixtures: Fixtures = {};
  const opById = new Map(spec.operations.map((o) => [o.id, o]));

  for (const plan of analysis.plans) {
    const op = opById.get(plan.operationId)!;
    if (plan.reversibility === 'unknown') {
      const segs = op.path.split('/').filter(Boolean);
      const prefix = '/' + segs.slice(0, Math.max(1, segs.length - 1)).join('/');
      const candidates = plan.suggestion
        ? [plan.suggestion.inverse]
        : spec.operations
            .filter((o) => o.id !== op.id && o.method !== 'get' && o.path.startsWith(prefix))
            .map((o) => o.id)
            .slice(0, 8);
      overrides[op.id] = {
        inverse: '',
        bindings: {},
        _reason: plan.reasons[0],
        _candidates: candidates,
        _help:
          'Set "inverse" to the operationId that undoes this one and bind its path params from params.x, response.x, request.x or "location". ' +
          'Or set "reversibility": "irreversible" with a "reason".',
      };
    }
    if (plan.strategy === 'paired-action' && plan.inverse) {
      const action = op.path.split('/').filter(Boolean).at(-1) ?? '';
      if (SECOND_OF_PAIR.test(action)) {
        fixtures[op.id] = { prepare: [{ operationId: plan.inverse.operationId }], _note: `${action} needs ${plan.inverse.operationId} to run first` } as Fixture;
      }
    }
  }

  for (const r of report?.results ?? []) {
    if (r.outcome !== 'error' && r.outcome !== 'inconclusive') continue;
    const op = opById.get(r.operationId);
    if (!op) continue;
    const existing = (fixtures[op.id] ?? {}) as Fixture & Record<string, unknown>;
    fixtures[op.id] = {
      ...existing,
      body: synthesize(op.requestSchema, op.requestExample),
      _note: `${r.outcome}: ${r.detail}`,
      ...(op.pathParams.length ? { _params: Object.fromEntries(op.pathParams.map((p) => [p, `id of an existing ${p.replace(/_?id$/i, '')}`])) } : {}),
    } as Fixture;
  }
  return { overrides, fixtures };
}

/** Merge generated entries under existing ones: what you already wrote always wins. */
export function mergeKeepingExisting<T extends object>(generated: Record<string, T>, existing: Record<string, T>): Record<string, T> {
  return { ...generated, ...existing };
}
