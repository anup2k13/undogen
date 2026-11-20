/**
 * `undogen wrap --verify`: prove a wrapped server's undo plans against a sandbox (experimental).
 *
 * For each step: read the probes (tools that show the state, e.g. list_issues), make the call through
 * the journal, undo it, read the probes again, and diff. Setup calls run first (their results can be
 * used by later arguments as "${setup.0.number}") and are undone at the end. Irreversible and unknown
 * tools are never called.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getPath } from '../runtime.js';
import { DEFAULT_IGNORED_FIELDS, diffStates, type StateDiff } from '../verify.js';
import type { ToolPlan } from './plans.js';
import { resultData, ToolSession, type CallUpstream, type ToolCall } from './session.js';

export interface WrapFixtures {
  /** Reads that show the state the steps change, compared before each call and after its undo. */
  probe?: ToolCall | ToolCall[];
  /** Calls that set up what the steps need; undone at the end. */
  setup?: ToolCall[];
  /** The calls whose undo is checked, each with its own probes if the shared ones don't show it. */
  steps: Array<ToolCall & { probe?: ToolCall | ToolCall[] }>;
  /** Fields to ignore when comparing (timestamps are ignored by default). */
  ignore?: string[];
}

export type WrapOutcome = 'verified' | 'compensated' | 'failed' | 'inconclusive' | 'gated' | 'error';

export interface WrapResult {
  tool: string;
  /** The action of a multi-action tool, e.g. "update" for issue_write. */
  action?: string;
  reversibility: ToolPlan['reversibility'];
  strategy: ToolPlan['strategy'];
  outcome: WrapOutcome;
  detail: string;
  diffs: StateDiff[];
}

export interface WrapVerifyReport {
  results: WrapResult[];
  /** Problems undoing the setup calls at the end. */
  cleanup: string[];
  summary: Record<WrapOutcome, number> & { total: number };
}

class FixtureError extends Error {}

/** Replace "${setup.N.path}" strings (whole values) with that setup call's result field. */
function fill(value: unknown, setup: unknown[]): unknown {
  if (typeof value === 'string') {
    const m = /^\$\{setup\.(\d+)\.(.+)\}$/.exec(value);
    if (!m) return value;
    const found = getPath(setup[Number(m[1])], m[2]!);
    if (found === undefined) throw new FixtureError(`${value}: setup call ${m[1]} returned no ${m[2]}`);
    return found;
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, setup));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, setup)]));
  return value;
}

const textOf = (r: CallToolResult) =>
  (r.content ?? [])
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join(' ')
    .slice(0, 200);

export async function verifyTools(options: {
  call: CallUpstream;
  plans: ToolPlan[];
  fixtures: WrapFixtures;
  onResult?: (r: WrapResult) => void;
}): Promise<WrapVerifyReport> {
  const { fixtures } = options;
  const ignore = new Set([...DEFAULT_IGNORED_FIELDS, ...(fixtures.ignore ?? [])]);
  // Nothing irreversible or unknown is ever approved here.
  const session = await ToolSession.open({ call: options.call, plans: options.plans, approve: async () => false });
  const results: WrapResult[] = [];
  const cleanup: string[] = [];
  const record = (r: WrapResult) => {
    results.push(r);
    options.onResult?.(r);
  };

  const setupData: unknown[] = [];
  let setupError: string | undefined;
  for (const [i, s] of (fixtures.setup ?? []).entries()) {
    try {
      const { result } = await session.call(s.tool, fill(s.arguments, setupData) as Record<string, unknown>);
      if (result.isError) throw new FixtureError(`${s.tool} failed: ${textOf(result)}`);
      setupData.push(resultData(result));
    } catch (err) {
      setupError = `setup call ${i} (${s.tool}): ${(err as Error).message}`;
      break;
    }
  }

  const read = async (probes: ToolCall[]) => {
    const state = new Map<string, { status: number; data: unknown }>();
    for (const p of probes) {
      const args = fill(p.arguments, setupData) as Record<string, unknown>;
      const r = await options.call(p.tool, args);
      state.set(`${p.tool} ${JSON.stringify(args)}`, { status: r.isError ? 500 : 200, data: r.isError ? textOf(r) : resultData(r) });
    }
    return state;
  };

  for (const step of fixtures.steps) {
    const plan = session.planFor(step.tool, step.arguments);
    const base = { tool: step.tool, ...(plan.dispatch ? { action: plan.dispatch.value } : {}), reversibility: plan.reversibility, strategy: plan.strategy, diffs: [] as StateDiff[] };
    if (setupError) {
      record({ ...base, outcome: 'error', detail: setupError });
      continue;
    }
    if (plan.reversibility === 'irreversible' || plan.reversibility === 'unknown') {
      record({ ...base, outcome: 'gated', detail: `never called: ${plan.reasons[0]}` });
      continue;
    }
    if (plan.strategy === 'no-side-effects') {
      record({ ...base, outcome: 'verified', detail: 'read-only: nothing to undo' });
      continue;
    }
    const probes = [step.probe ?? fixtures.probe ?? []].flat();
    if (!probes.length) {
      record({ ...base, outcome: 'error', detail: 'no probe: add "probe" (a read that shows what this call changes) to the fixtures' });
      continue;
    }
    try {
      const args = fill(step.arguments, setupData) as Record<string, unknown>;
      const before = await read(probes);
      const { result, entry } = await session.call(step.tool, args);
      if (result.isError || !entry) {
        record({ ...base, outcome: 'error', detail: `the call failed: ${textOf(result)} (fix its arguments in the fixtures)` });
        continue;
      }
      const after = await read(probes);
      const changed = diffStates(before, after, { ignore }).length > 0;
      try {
        await session.undo(entry);
      } catch (err) {
        record({ ...base, outcome: 'failed', detail: `undo failed: ${(err as Error).message}` });
        continue;
      }
      const restored = await read(probes);
      const diffs = diffStates(before, restored, { ignore });
      if (!diffs.length) {
        record({ ...base, outcome: changed ? 'verified' : 'inconclusive', detail: changed ? 'state restored exactly' : 'the probes showed no change, so the undo was not tested: pick a probe that shows it' });
      } else if (plan.reversibility === 'compensable') {
        record({ ...base, outcome: 'compensated', detail: `${diffs.length} difference(s) remain, as expected for a compensating undo (${plan.caveats[0] ?? plan.reasons[0]})`, diffs });
      } else {
        record({ ...base, outcome: 'failed', detail: `${diffs.length} difference(s) remain after undo`, diffs });
      }
    } catch (err) {
      record({ ...base, outcome: 'error', detail: (err as Error).message });
    }
  }

  // Undo the setup calls (the steps were undone one by one).
  const { failed } = await session.undoAll({ session: session.session });
  for (const f of failed) cleanup.push(`#${f.entry.seq} ${f.entry.tool}: ${f.error.message}`);

  const summary = { verified: 0, compensated: 0, failed: 0, inconclusive: 0, gated: 0, error: 0, total: results.length };
  for (const r of results) summary[r.outcome]++;
  return { results, cleanup, summary };
}
