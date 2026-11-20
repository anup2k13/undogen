/**
 * Journal and undo for calls to another MCP server's tools (experimental).
 * The counterpart of UndoableClient for tools instead of HTTP operations.
 */
import { randomUUID } from 'node:crypto';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getPath, MemoryJournalStore, stableStringify, type JournalStore } from '../runtime.js';
import { planKey, type ArgSource, type ToolCallTemplate, type ToolPlan } from './plans.js';

/** Calls a tool on the wrapped server. */
export type CallUpstream = (name: string, args: Record<string, unknown>, options?: RequestOptions) => Promise<CallToolResult>;

export interface ToolCall {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ToolEntry {
  kind: 'tool';
  seq: number;
  session: string;
  at: string;
  tool: string;
  arguments: Record<string, unknown>;
  reversibility: ToolPlan['reversibility'];
  strategy: ToolPlan['strategy'];
  /** The tool result (structured content, or parsed text). */
  result?: unknown;
  /** The state read before the call (restore-snapshot, recreate-from-snapshot). */
  before?: unknown;
  inverse?: ToolCall;
  /** Why there is no inverse. */
  inverseError?: string;
  /** The call changed nothing (the state read before and after was the same), so undo does nothing. */
  noop?: boolean;
  /** Ids this call created (the inverse's arguments read from the result), for finding later calls that use them. */
  created?: Array<{ name: string; value: unknown }>;
  /** The other arguments that locate what was created (owner, repo): a later call naming another scope doesn't depend on it. */
  scope?: Record<string, unknown>;
  /** Read before undoing; `expected` holds what the call left, as the server reported it right after. */
  check?: ToolCall & { expected: Record<string, unknown> };
  status: 'active' | 'undone' | 'failed' | 'conflict';
  undoError?: string;
  undoWarnings?: string[];
}

export interface ToolSessionOptions {
  call: CallUpstream;
  plans: ToolPlan[];
  store?: JournalStore<ToolEntry>;
  session?: string;
  /** Approve an irreversible or unknown call; refused when missing or false. */
  approve?: (plan: ToolPlan, call: ToolCall) => Promise<boolean>;
  /** Read and compare before undoing (default true). */
  checkConflicts?: boolean;
}

export class ToolRefusedError extends Error {
  constructor(readonly plan: ToolPlan) {
    super(`Refusing to call ${plan.tool}: it is ${plan.reversibility} (${plan.reasons.join('; ')}) and was not approved.`);
    this.name = 'ToolRefusedError';
  }
}

export class ToolUndoError extends Error {
  constructor(message: string, readonly entry: ToolEntry) {
    super(message);
    this.name = 'ToolUndoError';
  }
}

export class ToolDependencyError extends ToolUndoError {
  constructor(entry: ToolEntry, readonly dependents: ToolEntry[], otherSessions = false) {
    super(
      `Undo of #${entry.seq} (${entry.tool}) refused: later calls use what it created (${dependents.map((d) => `#${d.seq} ${d.tool}${otherSessions ? ` (session ${d.session})` : ''}`).join(', ')}). ` +
        (otherSessions ? "They belong to other sessions, which cascade doesn't touch: undo those sessions' calls first." : 'Undo those first, or pass cascade to undo them too.'),
      entry,
    );
    this.name = 'ToolDependencyError';
  }
}

export class ToolConflictError extends ToolUndoError {
  constructor(entry: ToolEntry, readonly conflicts: Array<{ field: string; expected: unknown; actual: unknown }>) {
    const what = conflicts.map((c) => `${c.field}: expected ${JSON.stringify(c.expected)}, found ${JSON.stringify(c.actual)}`).join('; ');
    super(`Undo of #${entry.seq} (${entry.tool}) refused: what it wrote has changed since (${what}). Pass force to overwrite anyway.`, entry);
    this.name = 'ToolConflictError';
  }
}

/** The data in a tool result: structured content, else the text parsed as JSON, else the text. */
export function resultData(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = (result.content ?? [])
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  try {
    return JSON.parse(text);
  } catch {
    return text || undefined;
  }
}

const errorText = (r: CallToolResult) =>
  (r.content ?? [])
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join(' ')
    .slice(0, 300);

export class ToolSession {
  readonly session: string;
  readonly journal: ToolEntry[] = [];
  private readonly plans: Map<string, ToolPlan>;
  /** Multi-action tools: the argument that picks the action. */
  private readonly dispatchArg = new Map<string, string>();
  /** Plans a real call disproved; they survive replacePlans. */
  private readonly downgraded = new Map<string, ToolPlan>();

  /** New plans after the wrapped server's tools changed; what real calls taught is kept. */
  replacePlans(plans: ToolPlan[]): void {
    this.plans.clear();
    this.dispatchArg.clear();
    for (const p of plans) {
      this.plans.set(planKey(p), this.downgraded.get(planKey(p)) ?? p);
      if (p.dispatch) this.dispatchArg.set(p.tool, p.dispatch.arg);
    }
  }
  private readonly store: JournalStore<ToolEntry>;
  private seq = 0;

  private constructor(private readonly options: ToolSessionOptions) {
    this.session = options.session ?? randomUUID().slice(0, 8);
    this.plans = new Map(options.plans.map((p) => [planKey(p), p]));
    for (const p of options.plans) if (p.dispatch) this.dispatchArg.set(p.tool, p.dispatch.arg);
    this.store = options.store ?? new MemoryJournalStore<ToolEntry>();
  }

  /** Open a session, loading earlier sessions' entries from the store. */
  static async open(options: ToolSessionOptions): Promise<ToolSession> {
    const s = new ToolSession(options);
    const entries = await s.store.load();
    if (entries.some((e) => (e as { kind?: string }).kind !== 'tool')) {
      throw new Error('This journal holds entries written by `undogen mcp` or UndoableClient; give `undogen wrap` its own --journal file');
    }
    s.journal.push(...entries);
    s.seq = Math.max(0, ...s.journal.map((e) => e.seq));
    return s;
  }

  /** The plan for a call; for a multi-action tool, the one for the action its arguments pick. */
  planFor(tool: string, args: Record<string, unknown> = {}): ToolPlan {
    const arg = this.dispatchArg.get(tool);
    if (arg) {
      const value = args[arg];
      return (
        this.plans.get(`${tool}#${String(value)}`) ?? {
          tool,
          reversibility: 'unknown',
          strategy: 'none',
          reasons: [`${tool} has no known action ${arg}: ${JSON.stringify(value)}`],
          caveats: [],
        }
      );
    }
    return this.plans.get(tool) ?? { tool, reversibility: 'unknown', strategy: 'none', reasons: ['not in the plans'], caveats: [] };
  }

  /** Call a tool: reads pass through; writes are journaled with the call that undoes them. */
  /** `options` (cancellation, progress) apply to the call itself, not to the reads around it. */
  async call(tool: string, args: Record<string, unknown>, options?: RequestOptions): Promise<{ result: CallToolResult; entry?: ToolEntry }> {
    let plan = this.planFor(tool, args);
    if (plan.strategy === 'no-side-effects') return { result: await this.options.call(tool, args, options) };
    const flag = plan.unsafeFlags?.find((f) => args[f] === true);
    if (flag && plan.reversibility !== 'irreversible') {
      plan = { ...plan, reversibility: 'unknown', reasons: [`with ${flag}: true, ${tool} replaces something its undo can't put back`, ...plan.reasons] };
    }

    // Read what the call will change first. If that fails, the call couldn't be undone: it needs approval like any other.
    let before: unknown;
    if (plan.snapshot) {
      let failure: string | undefined;
      try {
        const read = await this.options.call(plan.snapshot.tool, resolve(plan.snapshot, args, undefined, undefined));
        if (read.isError) failure = errorText(read);
        else before = resultData(read);
      } catch (err) {
        failure = (err as Error).message;
      }
      // Only an inverse built from the snapshot is lost; a paired action's undo doesn't need it.
      if (failure !== undefined && !plan.detectNoop) {
        plan = { ...plan, reversibility: 'unknown', reasons: [`${plan.snapshot.tool} could not read the current state first (${failure}), so this call could not be undone`, ...plan.reasons] };
      }
    }
    if (plan.reversibility === 'irreversible' || plan.reversibility === 'unknown') {
      if (!(await this.options.approve?.(plan, { tool, arguments: args }))) throw new ToolRefusedError(plan);
    }
    const result = await this.options.call(tool, args, options);
    if (result.isError) return { result }; // nothing happened: nothing to undo

    const data = resultData(result);
    const entry: ToolEntry = {
      kind: 'tool',
      seq: ++this.seq,
      session: this.session,
      at: new Date().toISOString(),
      tool,
      arguments: args,
      reversibility: plan.reversibility,
      strategy: plan.strategy,
      result: data,
      ...(before !== undefined ? { before } : {}),
      status: 'active',
    };
    try {
      const { call, notRestored } = this.inverseOf(plan, args, data, before);
      entry.inverse = call;
      const fromResult = Object.entries(plan.inverse?.arguments ?? {}).filter(([, src]) => 'from' in src && src.from === 'result');
      if (call && fromResult.length) {
        entry.created = fromResult.map(([name]) => ({ name, value: call.arguments[name] }));
        const fromArgs = Object.entries(plan.inverse?.arguments ?? {}).filter(([k, src]) => 'from' in src && src.from === 'args' && call.arguments[k] !== undefined);
        if (fromArgs.length) entry.scope = Object.fromEntries(fromArgs.map(([k]) => [k, call.arguments[k]]));
      }
      if (notRestored.length) {
        entry.undoWarnings = [`undo will not restore ${notRestored.join(', ')}: ${plan.snapshot?.tool} returned no earlier value for ${notRestored.length === 1 ? 'it' : 'them'}`];
      }
    } catch (err) {
      entry.inverseError = (err as Error).message;
      // The plan was a guess that this call disproved: from now on, treat the tool as unknown (approval needed).
      if (plan.reversibility !== 'irreversible' && plan.reversibility !== 'unknown') {
        const downgraded: ToolPlan = { ...plan, reversibility: 'unknown', strategy: 'none', inverse: undefined, reasons: [`its undo could not be worked out from a real call (${entry.inverseError})`, ...plan.reasons] };
        this.plans.set(planKey(plan), downgraded);
        this.downgraded.set(planKey(plan), downgraded);
      }
    }
    if (plan.detectNoop && plan.snapshot && before !== undefined) {
      try {
        const read = await this.options.call(plan.snapshot.tool, resolve(plan.snapshot, args, undefined, undefined));
        if (!read.isError && stableStringify(resultData(read)) === stableStringify(before)) entry.noop = true;
      } catch {
        /* can't tell: undo will call the inverse */
      }
    }
    // The write happened: journal it before anything else can fail.
    this.journal.push(entry);
    await this.store.save(entry);
    if (entry.inverse && plan.check && this.options.checkConflicts !== false) {
      // Record what the call left, as the server reports it, so undo can tell whether someone changed it since.
      try {
        const checkArgs = resolve(plan.check, args, data, before);
        const touched = Object.keys(args).filter((k) => !(k in checkArgs));
        const after = await this.options.call(plan.check.tool, checkArgs);
        if (!after.isError) {
          const state = resultData(after);
          const expected = Object.fromEntries(touched.filter((k) => getPath(state, k) !== undefined).map((k) => [k, getPath(state, k)]));
          if (Object.keys(expected).length) {
            entry.check = { tool: plan.check.tool, arguments: checkArgs, expected };
            await this.store.save(entry);
          }
        }
      } catch {
        /* no check possible; undo proceeds unchecked */
      }
    }
    return { result, entry };
  }

  private inverseOf(plan: ToolPlan, args: Record<string, unknown>, data: unknown, before: unknown): { call?: ToolCall; notRestored: string[] } {
    if (!plan.inverse) return { notRestored: [] };
    const out = resolve(plan.inverse, args, data, before);
    let notRestored: string[] = [];
    if (plan.restoreSent) {
      if (before === undefined) throw new Error(`${plan.snapshot?.tool} could not read the old values before the call`);
      const sent = Object.keys(args).filter((k) => !plan.restoreSent!.includes(k) && k !== plan.dispatch?.arg);
      const restorable = sent.filter((k) => getPath(before, k) !== undefined);
      if (!restorable.length) throw new Error(`the old values of ${sent.join(', ')} were not in what ${plan.snapshot?.tool} returned`);
      for (const k of restorable) out[k] = getPath(before, k);
      notRestored = sent.filter((k) => !restorable.includes(k));
    }
    return { call: { tool: plan.inverse.tool, arguments: out }, notRestored };
  }

  /** Undo one entry (default: this session's most recent active one). */
  /** Later, not-undone calls that use an id this entry created: the same argument name and value, or an id-like string (4+ characters) anywhere. */
  dependentsOf(entry: ToolEntry): ToolEntry[] {
    if (!entry.created?.length) return [];
    const ids = entry.created.flatMap(({ name, value }) => (Array.isArray(value) ? value : [value]).map((v) => ({ name, v })));
    return this.journal.filter(
      (e) =>
        e.seq > entry.seq &&
        e.status !== 'undone' &&
        !!e.inverse &&
        ids.some(({ name, v }) => (usesArg(e.arguments, name, v) && sameScope(entry.scope, e.arguments)) || (typeof v === 'string' && v.length >= 4 && mentions(e.arguments, v))),
    );
  }

  /**
   * Undo one entry (default: this session's most recent active one). With `cascade`, later calls that use
   * what it created are undone first, after its own checks pass. `undone` collects every entry undone.
   */
  async undo(target?: number | ToolEntry, opts: { force?: boolean; cascade?: boolean; cascadeWithin?: string; undone?: ToolEntry[] } = {}): Promise<ToolEntry> {
    const entry =
      typeof target === 'object'
        ? target
        : target !== undefined
          ? this.journal.find((e) => e.seq === target)
          : [...this.journal].reverse().find((e) => e.session === this.session && e.status !== 'undone');
    if (!entry) throw new Error(target !== undefined ? `No journal entry #${target}` : 'Nothing to undo');
    if (entry.status === 'undone') throw new ToolUndoError(`Entry #${entry.seq} is already undone`, entry);
    if (entry.noop) {
      entry.undoWarnings = [...(entry.undoWarnings ?? []), 'the call changed nothing, so there was nothing to undo'];
      opts.undone?.push(entry);
      return this.finish(entry);
    }
    const dependents = this.dependentsOf(entry);
    const others = opts.cascadeWithin !== undefined ? dependents.filter((d) => d.session !== opts.cascadeWithin) : [];
    if (dependents.length && (!opts.cascade || others.length)) throw new ToolDependencyError(entry, others.length ? others : dependents, !!opts.cascade && others.length > 0);
    if (!entry.inverse) {
      entry.status = 'failed';
      entry.undoError = `cannot be undone: ${entry.inverseError ?? describeNoInverse(entry)}`;
      await this.store.save(entry);
      throw new ToolUndoError(`Entry #${entry.seq} (${entry.tool}) ${entry.undoError}`, entry);
    }

    if (entry.check && !opts.force && this.options.checkConflicts !== false) {
      const read = await this.options.call(entry.check.tool, entry.check.arguments);
      if (read.isError) {
        // Tool errors carry no status code: "not found" can't be told from an outage or a permissions error, so don't guess.
        throw new ToolUndoError(`Undo of #${entry.seq}: could not read the current state (${entry.check.tool}: ${errorText(read)}). Pass force to undo without checking.`, entry);
      }
      const state = resultData(read);
      const conflicts = Object.entries(entry.check.expected)
        .filter(([k, v]) => stableStringify(getPath(state, k)) !== stableStringify(v))
        .map(([field, expected]) => ({ field, expected, actual: getPath(state, field) }));
      if (conflicts.length) {
        entry.status = 'conflict';
        entry.undoError = 'changed since the call';
        await this.store.save(entry);
        throw new ToolConflictError(entry, conflicts);
      }
    }
    // Only now, with this entry's own checks passed, undo what depends on it.
    for (const d of [...dependents].reverse()) if (d.status !== 'undone') await this.undo(d, opts);

    const res = await this.options.call(entry.inverse.tool, entry.inverse.arguments);
    if (res.isError) {
      entry.status = 'failed';
      entry.undoError = `${entry.inverse.tool} failed: ${errorText(res)}`;
      await this.store.save(entry);
      throw new ToolUndoError(`Undo of #${entry.seq} (${entry.tool}) failed: ${entry.undoError}`, entry);
    }
    opts.undone?.push(entry);
    return this.finish(entry);
  }

  private async finish(entry: ToolEntry): Promise<ToolEntry> {
    entry.status = 'undone';
    entry.undoError = undefined;
    await this.store.save(entry);
    return entry;
  }

  /** Undo entries newest first: all of them, one session's, or those after a checkpoint. */
  async undoAll(opts: { force?: boolean; cascade?: boolean; after?: number; session?: string } = {}): Promise<{ undone: ToolEntry[]; failed: Array<{ entry: ToolEntry; error: Error }> }> {
    const undone: ToolEntry[] = [];
    const failed: Array<{ entry: ToolEntry; error: Error }> = [];
    for (const entry of [...this.journal].reverse()) {
      if (entry.status === 'undone' || (opts.after !== undefined && entry.seq <= opts.after) || (opts.session !== undefined && entry.session !== opts.session)) continue;
      if ((entry.status as ToolEntry['status']) === 'undone') continue; // a cascade earlier in this loop may have undone it
      try {
        // Rolling back one session never cascades into another session's writes.
        await this.undo(entry, { ...opts, undone, ...(opts.session !== undefined ? { cascadeWithin: opts.session } : {}) }); // also collects what a cascade undid
      } catch (err) {
        failed.push({ entry, error: err as Error });
      }
    }
    return { undone, failed };
  }

  /** The current position, to roll back to with undoAll({ after }). */
  checkpoint(): number {
    return this.seq;
  }
}

function describeNoInverse(entry: ToolEntry): string {
  return entry.reversibility === 'irreversible' ? 'it is irreversible' : 'no tool undoes it';
}

/** Whether `args` passes `value` under the argument `name`, at any depth (or in an array under it). */
function usesArg(args: unknown, name: string, value: unknown): boolean {
  if (Array.isArray(args)) return args.some((x) => usesArg(x, name, value));
  if (!args || typeof args !== 'object') return false;
  return Object.entries(args).some(
    ([k, v]) => (k === name && (stableStringify(v) === stableStringify(value) || (Array.isArray(v) && v.some((x) => stableStringify(x) === stableStringify(value))))) || usesArg(v, name, value),
  );
}

/** Whether a later call's arguments agree with where something was created (same owner/repo), where they name it at all. */
function sameScope(scope: Record<string, unknown> | undefined, args: Record<string, unknown>): boolean {
  return Object.entries(scope ?? {}).every(([k, v]) => args[k] === undefined || stableStringify(args[k]) === stableStringify(v));
}

/** Whether a string appears as a value anywhere in `args`. */
function mentions(args: unknown, value: string): boolean {
  if (args === value) return true;
  if (Array.isArray(args)) return args.some((x) => mentions(x, value));
  return !!args && typeof args === 'object' && Object.values(args).some((x) => mentions(x, value));
}

/** Resolve a template's arguments against the original call. Throws when a needed value is missing. */
function resolve(t: ToolCallTemplate, args: Record<string, unknown>, data: unknown, before: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, src] of Object.entries(t.arguments)) {
    const value = valueOf(src, args, data, before);
    if (value !== undefined) out[name] = value;
    else if (!('from' in src && (src.from === 'args' || (src.from === 'before' && src.optional)))) {
      const where = 'value' in src ? 'value' : src.from === 'result' ? `result (${src.keys.join(' / ')})` : `${src.from}.${src.key}`;
      throw new Error(`${t.tool} needs ${name}, and the ${where} was not there`);
    }
  }
  return out;
}

function valueOf(src: ArgSource, args: Record<string, unknown>, data: unknown, before: unknown): unknown {
  if ('value' in src) return src.value;
  if (src.from === 'args') return args[src.key];
  if (src.from === 'before') return getPath(before, src.key);
  for (const k of src.keys) {
    const v = pick(data, k);
    if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) return v;
  }
  return undefined;
}

/** getPath, plus `items[].id` (that field of every item; undefined if any item lacks it). */
function pick(data: unknown, key: string): unknown {
  const i = key.indexOf('[].');
  if (i === -1) return getPath(data, key);
  const list = i === 0 ? data : getPath(data, key.slice(0, i));
  if (!Array.isArray(list)) return undefined;
  const values = list.map((x) => getPath(x, key.slice(i + 3)));
  return values.every((v) => v !== undefined && v !== null) ? values : undefined;
}
