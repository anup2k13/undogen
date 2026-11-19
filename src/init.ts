import { analyze } from './analyze.js';
import type { ApiSpec, InversePlan } from './types.js';
import { synthesize, verify, type Fixture, type Fixtures, type OperationResult, type VerifyReport } from './verify.js';

export interface InitOptions {
  spec: ApiSpec;
  plans?: InversePlan[];
  /** When given, run the verifier against this sandbox to check and refine the fixtures. */
  baseUrl?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  onProgress?: (message: string) => void;
}

export interface InitResult {
  fixtures: Fixtures;
  /** Operations that still need a human: bad bodies, missing ids, ... */
  todo: Array<{ operationId: string; reason: string }>;
  /** The final verification run, when a base URL was given. */
  report?: VerifyReport;
}

const REVERSE_PREFIXES = ['un', 'de', 'dis'];
const REVERSE_WORDS = new Set(['close', 'stop', 'resume', 'remove', 'detach', 'show']);

/** "unarchive", "deactivate", "disable", "stop": actions that undo a state some other action sets. */
function isReverseAction(plan: InversePlan): boolean {
  if (plan.strategy === 'toggle') return plan.method === 'delete';
  if (plan.strategy !== 'paired-action') return false;
  const last = plan.path.split('/').filter(Boolean).at(-1)?.toLowerCase() ?? '';
  return REVERSE_PREFIXES.some((p) => last.startsWith(p) && last.length > p.length + 2) || REVERSE_WORDS.has(last);
}

function hasBody(op: ApiSpec['operations'][number]): boolean {
  return !!op.requestSchema?.properties || op.requestExample !== undefined;
}

/**
 * Generate a starter fixtures file for `undogen verify`.
 *
 * Without a base URL, fixtures come from the spec alone: example bodies for
 * every create operation, and a `prepare` step for actions that only make
 * sense after their counterpart (archive before unarchive).
 *
 * With a base URL, the fixtures are verified against the sandbox: operations
 * that turn out to be no-ops get a prepare step, prepare steps that don't help
 * are dropped, and anything that still needs a human is listed in `todo`.
 */
export async function generateFixtures(options: InitOptions): Promise<InitResult> {
  const { spec } = options;
  const plans = options.plans ?? analyze(spec).plans;
  const opById = new Map(spec.operations.map((o) => [o.id, o]));
  const fixtures: Fixtures = {};
  const set = (id: string, patch: Fixture) => (fixtures[id] = { ...fixtures[id], ...patch });

  // 1. Static pass.
  for (const plan of plans) {
    const op = opById.get(plan.operationId)!;
    if (plan.reversibility === 'irreversible' || plan.reversibility === 'unknown') continue;
    if ((plan.strategy === 'delete-created' || plan.strategy === 'soft-delete') && hasBody(op)) {
      set(op.id, { body: synthesize(op.requestSchema, op.requestExample), note: 'Example body used to create test resources. Edit to match your API.' });
    }
    if (isReverseAction(plan) && plan.inverse && plan.inverse.operationId !== op.id) {
      set(op.id, { prepare: [{ operationId: plan.inverse.operationId }], note: `Runs ${plan.inverse.operationId} first so there is something to reverse.` });
    }
  }

  const todo: InitResult['todo'] = [];
  if (!options.baseUrl) return { fixtures, todo };

  // 2. Probe pass: verify, then fix what the results point at.
  const run = (only?: string[]) =>
    verify({ spec, plans, baseUrl: options.baseUrl!, headers: options.headers, fetch: options.fetch, fixtures, only });
  options.onProgress?.('verifying the generated fixtures against the sandbox…');
  let report = await run();
  let changed = false;

  const retry = async (r: OperationResult, attempt: Fixture, why: string) => {
    const previous = fixtures[r.operationId];
    fixtures[r.operationId] = { ...previous, ...attempt };
    const again = (await run([r.operationId])).results[0]!;
    if (again.outcome === 'verified' || again.outcome === 'failed') {
      options.onProgress?.(`${r.operationId}: ${why} → ${again.outcome}`);
      changed = true;
      return true;
    }
    if (previous) fixtures[r.operationId] = previous;
    else delete fixtures[r.operationId];
    return false;
  };

  for (const r of report.results) {
    const plan = plans.find((p) => p.operationId === r.operationId)!;
    const counterpart = plan.inverse?.operationId;
    if (r.outcome === 'inconclusive') {
      const hasPrepare = !!fixtures[r.operationId]?.prepare?.length;
      if (!hasPrepare && counterpart && counterpart !== r.operationId) {
        const fixed = await retry(r, { prepare: [{ operationId: counterpart }], note: `Runs ${counterpart} first so there is something to reverse.` }, `added prepare ${counterpart}`);
        if (fixed) continue;
      }
      todo.push({ operationId: r.operationId, reason: 'changes nothing visible in a fresh resource: add a prepare step that sets up the state it acts on' });
    } else if (r.outcome === 'error') {
      todo.push({ operationId: r.operationId, reason: r.detail });
      set(r.operationId, { note: `TODO: ${r.detail}` });
    }
  }

  // Prepare steps from the static pass are kept even when an operation passes without them:
  // they make the test meaningful rather than lucky.
  if (changed) report = await run();
  return { fixtures, todo, report };
}
