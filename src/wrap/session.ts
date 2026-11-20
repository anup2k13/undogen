/**
 * Journal and undo for calls to another MCP server's tools (experimental).
 * The counterpart of UndoableClient for tools instead of HTTP operations.
 */
import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getPath, MemoryJournalStore, stableStringify, type JournalStore } from '../runtime.js';
import type { ArgSource, ToolCallTemplate, ToolPlan } from './plans.js';

/** Calls a tool on the wrapped server. */
export type CallUpstream = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;

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
  private readonly store: JournalStore<ToolEntry>;
  private seq = 0;

  private constructor(private readonly options: ToolSessionOptions) {
    this.session = options.session ?? randomUUID().slice(0, 8);
    this.plans = new Map(options.plans.map((p) => [p.tool, p]));
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

  planFor(tool: string): ToolPlan {
    return this.plans.get(tool) ?? { tool, reversibility: 'unknown', strategy: 'none', reasons: ['not in the plans'], caveats: [] };
  }

  /** Call a tool: reads pass through; writes are journaled with the call that undoes them. */
  async call(tool: string, args: Record<string, unknown>): Promise<{ result: CallToolResult; entry?: ToolEntry }> {
    let plan = this.planFor(tool);
    if (plan.strategy === 'no-side-effects') return { result: await this.options.call(tool, args) };

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
      if (failure !== undefined) {
        plan = { ...plan, reversibility: 'unknown', reasons: [`${plan.snapshot.tool} could not read the current state first (${failure}), so this call could not be undone`, ...plan.reasons] };
      }
    }
    if (plan.reversibility === 'irreversible' || plan.reversibility === 'unknown') {
      if (!(await this.options.approve?.(plan, { tool, arguments: args }))) throw new ToolRefusedError(plan);
    }
    const result = await this.options.call(tool, args);
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
      if (notRestored.length) {
        entry.undoWarnings = [`undo will not restore ${notRestored.join(', ')}: ${plan.snapshot?.tool} returned no earlier value for ${notRestored.length === 1 ? 'it' : 'them'}`];
      }
    } catch (err) {
      entry.inverseError = (err as Error).message;
      // The plan was a guess that this call disproved: from now on, treat the tool as unknown (approval needed).
      if (plan.reversibility !== 'irreversible' && plan.reversibility !== 'unknown') {
        this.plans.set(tool, { ...plan, reversibility: 'unknown', strategy: 'none', inverse: undefined, reasons: [`its undo could not be worked out from a real call (${entry.inverseError})`, ...plan.reasons] });
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
      const sent = Object.keys(args).filter((k) => !plan.restoreSent!.includes(k));
      const restorable = sent.filter((k) => getPath(before, k) !== undefined);
      if (!restorable.length) throw new Error(`the old values of ${sent.join(', ')} were not in what ${plan.snapshot?.tool} returned`);
      for (const k of restorable) out[k] = getPath(before, k);
      notRestored = sent.filter((k) => !restorable.includes(k));
    }
    return { call: { tool: plan.inverse.tool, arguments: out }, notRestored };
  }

  /** Undo one entry (default: this session's most recent active one). */
  async undo(target?: number | ToolEntry, opts: { force?: boolean } = {}): Promise<ToolEntry> {
    const entry =
      typeof target === 'object'
        ? target
        : target !== undefined
          ? this.journal.find((e) => e.seq === target)
          : [...this.journal].reverse().find((e) => e.session === this.session && e.status !== 'undone');
    if (!entry) throw new Error(target !== undefined ? `No journal entry #${target}` : 'Nothing to undo');
    if (entry.status === 'undone') throw new ToolUndoError(`Entry #${entry.seq} is already undone`, entry);
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

    const res = await this.options.call(entry.inverse.tool, entry.inverse.arguments);
    if (res.isError) {
      entry.status = 'failed';
      entry.undoError = `${entry.inverse.tool} failed: ${errorText(res)}`;
      await this.store.save(entry);
      throw new ToolUndoError(`Undo of #${entry.seq} (${entry.tool}) failed: ${entry.undoError}`, entry);
    }
    return this.finish(entry);
  }

  private async finish(entry: ToolEntry): Promise<ToolEntry> {
    entry.status = 'undone';
    entry.undoError = undefined;
    await this.store.save(entry);
    return entry;
  }

  /** Undo entries newest first: all of them, one session's, or those after a checkpoint. */
  async undoAll(opts: { force?: boolean; after?: number; session?: string } = {}): Promise<{ undone: ToolEntry[]; failed: Array<{ entry: ToolEntry; error: Error }> }> {
    const undone: ToolEntry[] = [];
    const failed: Array<{ entry: ToolEntry; error: Error }> = [];
    for (const entry of [...this.journal].reverse()) {
      if (entry.status === 'undone' || (opts.after !== undefined && entry.seq <= opts.after) || (opts.session !== undefined && entry.session !== opts.session)) continue;
      try {
        undone.push(await this.undo(entry, opts));
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
