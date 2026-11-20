import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { analyze } from './analyze.js';
import type { ApiSpec, BodyTemplate, ChildPlan, HttpMethod, InversePlan, Operation, RequestTemplate, ValueRef } from './types.js';

type Scalar = string | number;
type QueryValue = string | number | boolean;

export interface CallInput {
  params?: Record<string, Scalar>;
  query?: Record<string, QueryValue>;
  /** Per-call headers (header parameters of the operation). */
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpResult {
  status: number;
  data: unknown;
  headers: Record<string, string>;
}

export interface ResolvedRequest {
  operationId: string;
  method: HttpMethod;
  /** The concrete path, e.g. /todos/t1. */
  path: string;
  /** The route template, e.g. /todos/{todoId}; lets the path be rebuilt when ids change. */
  pathTemplate?: string;
  params?: Record<string, Scalar>;
  query?: Record<string, QueryValue>;
  body?: unknown;
  contentType?: string;
  /** journalDetail 'minimal': salted hashes of id-like values in the body, for dependency checks without the body. */
  bodyRefs?: string[];
}

/** Children of a deleted resource, captured so the undo can re-create them. */
export interface CapturedChildren {
  plan: ChildPlan;
  params: Record<string, Scalar>;
  items: unknown[];
  /** Grandchildren: itemChildren[i] belongs to items[i]. */
  itemChildren?: CapturedChildren[][];
}

/**
 * - active:   applied, not undone
 * - undone:   the inverse ran successfully
 * - failed:   the inverse could not be built, or the request failed
 * - conflict: someone changed what this entry wrote, so the undo was refused
 */
export type EntryStatus = 'active' | 'undone' | 'failed' | 'conflict';

export interface JournalEntry {
  seq: number;
  /** Identifies the client session that made the call. */
  session: string;
  at: string;
  operationId: string;
  request: ResolvedRequest;
  response: HttpResult;
  /** State captured before the call; `null` means the resource did not exist. */
  before?: unknown;
  children?: CapturedChildren[];
  plan: Pick<InversePlan, 'reversibility' | 'strategy' | 'confidence'>;
  /** The concrete request that undoes this entry, resolved at call time. */
  inverse: ResolvedRequest | null;
  /** Why `inverse` is null, if it is. */
  inverseError?: string;
  /** What the call left behind; re-read before undoing to detect someone else's change. */
  check?: {
    pathTemplate: string;
    params: Record<string, Scalar>;
    query?: Record<string, QueryValue>;
    expected: Record<string, unknown>;
    /** 'diff': `expected` holds the fields the call changed ("(status)" for the HTTP status). */
    mode?: 'diff';
  };
  /** The call changed nothing (e.g. starring an already-starred repo), so undo does nothing. */
  noop?: boolean;
  /** The resource this call created, so later calls that use it are known to depend on it. */
  /** The resource this call created. `chosen`: its id came from the request (a name the caller picked, like "test"). */
  created?: { param: string; value: Scalar; chosen?: boolean };
  identity?: { param: string; responseKey: string };
  /** Fingerprint of irreversible calls, used to refuse accidental replays. */
  fingerprint?: string;
  status: EntryStatus;
  /** Same as status === 'undone'; kept for compatibility. */
  undone: boolean;
  undoResponse?: HttpResult;
  undoError?: string;
  undoAttempts?: number;
  undoWarnings?: string[];
  /** Ids that changed when this entry was undone: param -> old id -> new id. */
  idMap?: Record<string, Record<string, Scalar>>;
}

export class IrreversibleOperationError extends Error {
  constructor(public readonly operationId: string, public readonly plan: InversePlan) {
    super(
      `Refusing to run ${operationId}: it is ${plan.reversibility} (${plan.reasons.join('; ') || 'no inverse'}). ` +
        'Pass allowIrreversible to approve it explicitly.',
    );
    this.name = 'IrreversibleOperationError';
  }
}

/** An irreversible call identical to one already made (e.g. an agent restored from a checkpoint retrying it). */
export class ReplayBlockedError extends IrreversibleOperationError {
  constructor(operationId: string, plan: InversePlan, public readonly previous: JournalEntry) {
    super(operationId, plan);
    this.message =
      `Refusing to repeat ${operationId}: an identical irreversible call already ran as #${previous.seq} at ${previous.at}. ` +
      'Approve it explicitly with an allowIrreversible function (it receives { replayOf }) or set allowReplays.';
    this.name = 'ReplayBlockedError';
  }
}

export class UndoError extends Error {
  constructor(message: string, public readonly entry: JournalEntry, public readonly response?: HttpResult) {
    super(message);
    this.name = 'UndoError';
  }
}

export interface Conflict {
  field: string;
  expected: unknown;
  actual: unknown;
}

/** The state an entry produced was changed by someone else; undoing would overwrite their change. */
export class ConflictError extends UndoError {
  constructor(entry: JournalEntry, public readonly conflicts: Conflict[], response?: HttpResult) {
    const what = conflicts.map((c) => `${c.field}: expected ${JSON.stringify(c.expected)}, found ${JSON.stringify(c.actual)}`).join('; ');
    super(
      `Undo of #${entry.seq} (${entry.operationId}) refused: the state it wrote has changed since (${what}). ` +
        'Pass { force: true } to overwrite anyway.',
      entry,
      response,
    );
    this.name = 'ConflictError';
  }
}

/** Later entries use what this entry created; undo them first (or pass { cascade: true }). */
export class DependencyError extends UndoError {
  /**
   * `dependents`: the direct dependents, or with `cascadeRefused` the other sessions' writes a cascade would reach.
   * `otherSessions` (without cascade): writes from other sessions further down, which a cascade would also stop at.
   */
  constructor(entry: JournalEntry, public readonly dependents: JournalEntry[], otherSessionsOrRefused: JournalEntry[] | boolean = [], cascadeRefused = false) {
    // Also accepts the earlier (entry, dependents, otherSessions: boolean) form.
    const otherSessions = Array.isArray(otherSessionsOrRefused) ? otherSessionsOrRefused : [];
    if (otherSessionsOrRefused === true) cascadeRefused = true;
    const list = (ds: JournalEntry[], withSession: boolean) => ds.map((d) => `#${d.seq} ${d.operationId}${withSession ? ` (session ${d.session})` : ''}`).join(', ');
    super(
      cascadeRefused
        ? `Undo of #${entry.seq} (${entry.operationId}) would orphan later writes from other sessions: ${list(dependents, true)}. ` +
            "Cascade doesn't touch other sessions: undo those sessions' writes first."
        : `Undo of #${entry.seq} (${entry.operationId}) would orphan later writes that use it: ${list(dependents, false)}. ` +
            (otherSessions.length
              ? `Undo those first. (A cascade would stop at writes from other sessions: ${list(otherSessions, true)}.)`
              : 'Undo those first, or pass { cascade: true }.'),
      entry,
    );
    this.name = 'DependencyError';
  }
}

/** Where the journal lives. Implement this to keep it in a database. */
export interface JournalStore<E extends { seq: number } = JournalEntry> {
  load(): Promise<E[]>;
  /** Called after every change to an entry; the latest save of a seq wins. */
  save(entry: E): Promise<void>;
}

/** Keeps the journal in memory only (the default). */
export class MemoryJournalStore<E extends { seq: number } = JournalEntry> implements JournalStore<E> {
  private readonly entries = new Map<number, E>();
  async load() {
    return [...this.entries.values()].map(clone);
  }
  async save(entry: E) {
    this.entries.set(entry.seq, clone(entry));
  }
}

/** An append-only JSON Lines file. Survives restarts; another process can resume and undo from it. */
export class FileJournalStore<E extends { seq: number } = JournalEntry> implements JournalStore<E> {
  constructor(readonly path: string) {}
  async load(): Promise<E[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const bySeq = new Map<number, E>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line) as E;
      bySeq.set(e.seq, e);
    }
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }
  async save(entry: E) {
    await mkdir(dirname(this.path), { recursive: true });
    // Entries hold request and response bodies: keep the file readable by its owner only.
    await appendFile(this.path, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }

  /**
   * Rewrite the file with only the latest version of each entry (every save appends one).
   * Atomic: written to a temporary file, then renamed over the journal. Don't run it while
   * another process is appending to the same journal.
   */
  async compact(): Promise<{ before: number; after: number }> {
    let before = 0;
    try {
      before = (await readFile(this.path, 'utf8')).split('\n').filter((l) => l.trim()).length;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { before: 0, after: 0 };
      throw err;
    }
    const entries = await this.load();
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, entries.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
    await rename(tmp, this.path);
    return { before, after: entries.length };
  }
}

export interface OutgoingRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string | URLSearchParams | FormData;
}

export interface IrreversibleContext {
  /** Set when an identical irreversible call already ran in this journal. */
  replayOf?: JournalEntry;
}

export interface ClientOptions {
  spec: ApiSpec;
  baseUrl: string;
  /** Pre-compiled plans; compiled from `spec` when omitted. */
  plans?: InversePlan[];
  /** Static headers, or a function called before every request (e.g. to refresh a token). */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Last chance to change a request before it is sent, e.g. to sign it. */
  beforeRequest?: (req: OutgoingRequest) => void | Promise<void>;
  fetch?: typeof fetch;
  /**
   * Gate for operations that cannot be undone. `false` (default) blocks them;
   * a function lets a human or policy engine approve case by case.
   */
  allowIrreversible?:
    | boolean
    | ((op: Operation, plan: InversePlan, input: CallInput, context: IrreversibleContext) => boolean | Promise<boolean>);
  /** Allow an irreversible call identical to an earlier one when allowIrreversible is `true`. Default false. */
  allowReplays?: boolean;
  /** Where to keep the journal. Use `UndoableClient.open()` to load an existing one. */
  store?: JournalStore;
  /** Session id recorded on entries. Random by default. */
  session?: string;
  /** Re-read state before undoing and refuse if someone changed it. Default true. */
  checkConflicts?: boolean;
  /** Header carrying a stable key on undo requests, so retries are safe. `false` disables. Default "Idempotency-Key". */
  idempotencyHeader?: string | false;
  /** Retries for rate limits (429), timeouts and 5xx on requests that are safe to repeat. Default 2. */
  retries?: number;
  /** Base delay for exponential backoff. Default 250ms. */
  retryDelayMs?: number;
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
  /** When compiling plans here: also re-create child collections when undoing a delete. */
  restoreChildren?: boolean;
  /**
   * What the store keeps. 'full' (default): everything, for auditing. 'minimal': only what undo
   * needs (the resolved inverse, conflict-check values, ids, captured children); request and
   * response bodies and the captured state are dropped. The in-memory journal is always full.
   */
  journalDetail?: 'full' | 'minimal';
}

export interface UndoOptions {
  /** Undo even if someone changed the state since (skips the conflict check). */
  force?: boolean;
  /** Undo later entries that depend on this one first. */
  cascade?: boolean;
  /** With cascade, only undo dependents made by this session; dependents from other sessions refuse the undo. */
  cascadeWithin?: string;
  /** @internal Set on a cascade's own recursive undos: the top-level call already checked every dependent. */
  dependentsChecked?: boolean;
}

/**
 * An HTTP client for an OpenAPI-described API that journals every write
 * together with the request that undoes it.
 */
export class UndoableClient {
  readonly journal: JournalEntry[] = [];
  readonly session: string;
  private readonly ops: Map<string, Operation>;
  private readonly plans: Map<string, InversePlan>;
  private readonly fetchImpl: typeof fetch;
  private readonly store?: JournalStore;
  /** param -> old id -> new id, for resources re-created by undo. */
  private readonly idMap = new Map<string, Map<string, Scalar>>();
  private seq = 0;
  private loading?: Promise<void>;

  constructor(private readonly options: ClientOptions) {
    this.ops = new Map(options.spec.operations.map((o) => [o.id, o]));
    const plans = options.plans ?? analyze(options.spec, { restoreChildren: options.restoreChildren }).plans;
    this.plans = new Map(plans.map((p) => [p.operationId, p]));
    this.fetchImpl = options.fetch ?? fetch;
    this.store = options.store;
    this.session = options.session ?? randomUUID().slice(0, 8);
  }

  /** Create a client and load the journal from `options.store`, to resume or undo an earlier session. */
  static async open(options: ClientOptions): Promise<UndoableClient> {
    const client = new UndoableClient(options);
    await client.ready();
    return client;
  }

  /**
   * Load the journal from the store (once). `call` and `undo` wait for it, so a client
   * constructed directly on an existing journal never reuses its sequence numbers.
   */
  ready(): Promise<void> {
    this.loading ??= (async () => {
      const entries = (await this.store?.load()) ?? [];
      if (entries.some((e) => (e as { kind?: string }).kind === 'tool')) throw new Error('This journal was written by `undogen wrap` (tool calls, not HTTP requests); undo it with `undogen wrap --journal <file> --undo ... -- <server command>`');
      const known = new Set(this.journal.map((e) => e.seq));
      for (const entry of entries) {
        if (known.has(entry.seq)) continue;
        this.journal.push(entry);
        this.seq = Math.max(this.seq, entry.seq);
        for (const [param, map] of Object.entries(entry.idMap ?? {})) {
          for (const [oldId, newId] of Object.entries(map)) this.rememberId(param, oldId, newId);
        }
      }
      this.journal.sort((a, b) => a.seq - b.seq);
    })();
    return this.loading;
  }

  planFor(operationId: string): InversePlan | undefined {
    return this.plans.get(operationId);
  }

  operation(operationId: string): Operation | undefined {
    return this.ops.get(operationId);
  }

  /** Call an operation by operationId. Writes are journaled with their inverse. */
  async call(operationId: string, input: CallInput = {}): Promise<HttpResult & { entry?: JournalEntry }> {
    const op = this.ops.get(operationId);
    if (!op) throw new Error(`Unknown operation: ${operationId}`);
    await this.ready();
    const params = input.params ?? {};

    if (op.method === 'get') {
      return this.request(op.method, fillPath(op.path, params), { query: input.query, headers: input.headers });
    }

    const plan = this.plans.get(operationId);
    if (!plan) throw new Error(`No undo plan for ${operationId}`);

    let fingerprint: string | undefined;
    if (plan.reversibility === 'irreversible' || plan.reversibility === 'unknown') {
      fingerprint = fingerprintOf(operationId, input);
      const replayOf = this.journal.find((e) => e.fingerprint === fingerprint);
      const gate = this.options.allowIrreversible ?? false;
      const approved = typeof gate === 'function' ? await gate(op, plan, input, { replayOf }) : gate;
      if (!approved) throw new IrreversibleOperationError(operationId, plan);
      if (replayOf && typeof gate !== 'function' && !this.options.allowReplays) {
        throw new ReplayBlockedError(operationId, plan, replayOf);
      }
    }

    const pre: Sources = { params, query: input.query ?? {}, request: input.body };

    // Capture state before the write.
    let before: unknown;
    let captured = false;
    let children: CapturedChildren[] | undefined;
    if (plan.capture) {
      const snap = await this.request('get', resolvePath(plan.capture, pre), { query: resolveQuery(plan.capture, pre) });
      if (snap.status === 404 || snap.status === 410) before = null;
      else if (snap.status < 300) before = snap.data ?? {};
      else throw new Error(`Capture before ${operationId} failed: HTTP ${snap.status}`);
      captured = true;
      if (before !== null && plan.children?.length) children = await this.captureChildren(plan.children, params);
    }

    // Paired actions and toggles: read the state first, so we know what the call changed.
    let diffBefore: HttpResult | undefined;
    if (plan.checkMode && plan.check && this.options.checkConflicts !== false) {
      try {
        diffBefore = await this.request('get', resolvePath(plan.check, pre), { query: resolveQuery(plan.check, pre) });
      } catch {
        /* no check possible */
      }
    }

    const path = fillPath(op.path, params);
    const response = await this.request(op.method, path, {
      query: input.query,
      headers: input.headers,
      body: input.body,
      contentType: op.requestContentType,
    });
    if (response.status >= 400) return response; // nothing happened, nothing to undo

    const sources: Sources = { ...pre, response: response.data, responseHeaders: response.headers, before };
    const template = captured && before === null && plan.inverseIfMissing ? plan.inverseIfMissing : plan.inverse;
    let inverse: ResolvedRequest | null = null;
    let inverseError: string | undefined;
    if (template) {
      try {
        inverse = this.resolveRequest(template, sources);
      } catch (err) {
        inverseError = (err as Error).message;
      }
    } else if (plan.strategy !== 'no-side-effects') {
      inverseError = 'No inverse for this operation';
    }

    const entry: JournalEntry = {
      seq: ++this.seq,
      session: this.session,
      at: new Date().toISOString(),
      operationId,
      request: { operationId, method: op.method, path, pathTemplate: op.path, params: { ...params }, query: input.query, body: input.body, contentType: op.requestContentType },
      response,
      before: captured ? before : undefined,
      children,
      plan: { reversibility: plan.reversibility, strategy: plan.strategy, confidence: plan.confidence },
      inverse,
      inverseError,
      fingerprint,
      identity: plan.identity,
      status: 'active',
      undone: false,
    };
    if (inverse && plan.check && diffBefore) {
      try {
        const checkPath = resolvePath(plan.check, sources);
        const after = await this.request('get', checkPath, { query: resolveQuery(plan.check, sources) });
        const changed = changedState(diffBefore, after);
        if (Object.keys(changed).length) {
          entry.check = { pathTemplate: plan.check.path, params: resolveParams(plan.check, sources), query: resolveQuery(plan.check, sources), expected: changed, mode: 'diff' };
        } else if (plan.checkMode === 'diff-exact') {
          entry.noop = true;
        }
      } catch {
        /* no check possible; undo proceeds unchecked */
      }
    } else if (inverse && plan.check && !plan.checkMode && this.options.checkConflicts !== false) {
      try {
        entry.check = {
          pathTemplate: plan.check.path,
          params: resolveParams(plan.check, sources),
          query: resolveQuery(plan.check, sources),
          expected: expectedState(input.body, response.data, inverse.method === 'delete' || plan.strategy === 'soft-delete'),
        };
      } catch {
        /* no check possible; undo proceeds unchecked */
      }
    }
    if (inverse && template && (inverse.method === 'delete' || plan.strategy === 'soft-delete')) {
      const createdBy = createdBinding(template);
      if (createdBy && inverse.params?.[createdBy[0]] !== undefined) {
        entry.created = { param: createdBy[0], value: inverse.params[createdBy[0]]!, ...(createdBy[1].from === 'request' ? { chosen: true } : {}) };
      }
    }
    this.journal.push(entry);
    await this.persist(entry);
    return { ...response, entry };
  }

  /**
   * Later entries (not yet undone) that use the resource `entry` created. Entries that
   * can never be undone (irreversible calls, no inverse) don't count: undoing them first
   * is impossible, so they must not block the rest of a rollback.
   */
  dependentsOf(entry: JournalEntry): JournalEntry[] {
    if (!entry.created) return [];
    const { param, value } = entry.created;
    const ids = new Set([String(value), String(this.remapId(param, value))]);
    // In the body too (POST /comments { todoId }), but only for ids that can't be mistaken for small numbers,
    // and not for names the caller chose ("test", "prod"): those turn up in unrelated bodies.
    // A chosen name only counts in bodies when it looks like an id (PROJ-8f3a2c), not a word.
    const bodyIds = [...ids].filter((id) => (entry.created!.chosen ? idLike(id) : id.length >= 4));
    return this.journal.filter(
      (e) =>
        e.seq > entry.seq &&
        e.status !== 'undone' &&
        e.plan.strategy !== 'no-side-effects' &&
        e.inverse !== null &&
        ((e.request.params?.[param] !== undefined && ids.has(String(e.request.params[param]))) ||
          (bodyIds.length > 0 && bodyMentions(e.request.body, bodyIds)) ||
          (bodyIds.length > 0 && !!e.request.bodyRefs?.length && bodyIds.some((id) => e.request.bodyRefs!.includes(refHash(id, e.session))))),
    );
  }

  /** Every later entry that depends on this one, directly or through others (what a cascade would undo). */
  allDependentsOf(entry: JournalEntry): JournalEntry[] {
    const seen = new Map<number, JournalEntry>();
    const queue = this.dependentsOf(entry);
    while (queue.length) {
      const d = queue.shift()!;
      if (seen.has(d.seq)) continue;
      seen.set(d.seq, d);
      queue.push(...this.dependentsOf(d));
    }
    return [...seen.values()].sort((a, b) => a.seq - b.seq);
  }

  /** Undo one entry (or seq). Default: the most recent entry not yet undone. */
  async undo(entryOrSeq?: JournalEntry | number, opts: UndoOptions = {}): Promise<HttpResult> {
    await this.ready();
    const target =
      typeof entryOrSeq === 'number'
        ? this.journal.find((e) => e.seq === entryOrSeq)
        : entryOrSeq ?? [...this.journal].reverse().find((e) => e.status !== 'undone');
    if (!target) throw new Error(typeof entryOrSeq === 'number' ? `No journal entry #${entryOrSeq}` : 'Nothing to undo');
    if (target.status === 'undone') throw new UndoError(`Entry #${target.seq} is already undone`, target);

    const dependents = this.dependentsOf(target);
    if (dependents.length) {
      // Look at everything a cascade would reach, not only direct dependents, before undoing anything
      // (once, at the top: the cascade's own recursive undos skip it).
      const others =
        opts.cascadeWithin !== undefined && !opts.dependentsChecked ? this.allDependentsOf(target).filter((d) => d.session !== opts.cascadeWithin) : [];
      if (!opts.cascade) throw new DependencyError(target, dependents, others);
      if (others.length) throw new DependencyError(target, others, [], true);
    }
    // Undo what depends on this entry first: its own conflict check then compares against the state those writes
    // were undone to (a create edited later in the same session is cascaded back, not refused as changed). A conflict
    // found after that leaves the dependents undone; the error says so.
    for (const d of [...dependents].reverse()) if (d.status !== 'undone') await this.undo(d, { ...opts, dependentsChecked: true });
    const cascaded = dependents.filter((d) => d.status === 'undone');

    if (!target.inverse && target.plan.strategy === 'no-side-effects') {
      return this.finish(target, { status: 204, data: undefined, headers: {} });
    }
    if (target.noop) {
      target.undoWarnings = [...(target.undoWarnings ?? []), 'the call changed nothing, so there was nothing to undo'];
      return this.finish(target, { status: 204, data: undefined, headers: {} });
    }
    if (!target.inverse) {
      target.undoError = `cannot be undone: ${target.inverseError}`;
      target.status = 'failed';
      await this.persist(target);
      throw new UndoError(`Entry #${target.seq} (${target.operationId}) cannot be undone: ${target.inverseError}`, target);
    }

    const inverse = this.remapRequest(target.inverse);
    const headers: Record<string, string> = {};

    // Refuse to overwrite someone else's change.
    if (target.check && !opts.force && this.options.checkConflicts !== false) {
      const checkPath = fillPath(target.check.pathTemplate, this.remapParams(target.check.params));
      const current = await this.request('get', checkPath, { query: target.check.query });
      if (target.check.mode === 'diff') {
        // Paired action / toggle: the fields (or status) the call changed must still be as it left them.
        const conflicts = compareExpected(target.check.expected, stateOf(current), '', target.session);
        if (conflicts.length) return this.conflict(target, conflicts, current, cascaded);
      } else {
        if (current.status === 404 || current.status === 410) {
          if (inverse.method === 'delete') {
            target.undoWarnings = [...(target.undoWarnings ?? []), 'the resource was already gone'];
            return this.finish(target, current);
          }
          return this.conflict(target, [{ field: '(resource)', expected: 'exists', actual: `HTTP ${current.status}` }], current, cascaded);
        }
        if (current.status >= 300) {
          throw new UndoError(`Undo of #${target.seq}: could not read current state (GET ${checkPath} -> HTTP ${current.status})`, target, current);
        }
        const conflicts = compareExpected(target.check.expected, current.data, '', target.session);
        if (conflicts.length) return this.conflict(target, conflicts, current, cascaded);
      }
      const etag = current.headers['etag']; // read after the cascade, so it covers the inverse request
      // If-Match uses strong comparison (RFC 9110): a weak W/ validator would always fail with 412.
      if (etag && !etag.startsWith('W/') && checkPath === inverse.path) headers['if-match'] = etag;
    }

    const idemHeader = this.options.idempotencyHeader ?? 'Idempotency-Key';
    if (idemHeader) headers[idemHeader] = `undogen-${target.session}-${target.seq}-undo`;

    target.undoAttempts = (target.undoAttempts ?? 0) + 1;
    const res = await this.request(inverse.method, inverse.path, {
      query: inverse.query,
      body: inverse.body,
      contentType: inverse.contentType,
      headers,
      // Retrying a POST after a timeout or 5xx could create the resource twice if the API
      // ignores the idempotency key; restoring writes (PUT/PATCH/DELETE) are safe to repeat.
      idempotent: inverse.method !== 'post',
    });
    target.undoResponse = res;
    if (res.status === 412) {
      return this.conflict(target, [{ field: '(etag)', expected: headers['if-match'], actual: 'changed' }], res);
    }
    if (res.status >= 400 && !(inverse.method === 'delete' && (res.status === 404 || res.status === 410))) {
      target.status = 'failed';
      target.undoError = `${inverse.method.toUpperCase()} ${inverse.path} -> HTTP ${res.status}`;
      await this.persist(target);
      throw new UndoError(`Undo of #${target.seq} (${target.operationId}) failed: ${target.undoError}`, target, res);
    }

    // A re-created resource has a new id: remember it, so later undos address it.
    if (target.identity && inverse.method === 'post') {
      const oldId = target.request.params?.[target.identity.param];
      const newId = (getPath(res.data, target.identity.responseKey) ?? getPath(res.data, 'id')) as Scalar | undefined;
      if (oldId !== undefined && newId !== undefined) this.recordId(target, target.identity.param, oldId, newId);
    }
    if (target.children?.length) await this.restoreChildren(target);
    return this.finish(target, res);
  }

  /** Undo everything in reverse order (a saga rollback). Continues past failures and reports them. */
  /**
   * Mark the current point in the journal. Later, `undoTo(checkpoint)` rolls back
   * everything done since (e.g. one task of a longer agent session).
   */
  async checkpoint(): Promise<number> {
    await this.ready();
    return this.seq;
  }

  /** Undo every entry made after `checkpoint`, newest first. */
  undoTo(checkpoint: number, opts: Omit<UndoOptions, 'cascade'> = {}) {
    return this.undoAll({ ...opts, after: checkpoint });
  }

  async undoAll(
    opts: UndoOptions & {
      /** Only entries after this checkpoint (seq). */
      after?: number;
      /** Only entries made by this session (a persisted journal holds earlier sessions too). */
      session?: string;
    } = {},
  ): Promise<{ undone: JournalEntry[]; failed: Array<{ entry: JournalEntry; error: Error }> }> {
    await this.ready();
    const undone: JournalEntry[] = [];
    const failed: Array<{ entry: JournalEntry; error: Error }> = [];
    const { after, session, ...rest } = opts;
    // Rolling back one session never cascades into another session's writes.
    const undoOpts: UndoOptions = { ...rest, ...(session !== undefined ? { cascadeWithin: session } : {}) };
    for (const entry of [...this.journal].reverse()) {
      if (entry.status === 'undone') continue;
      if (after !== undefined && entry.seq <= after) continue;
      if (session !== undefined && entry.session !== session) continue;
      try {
        await this.undo(entry, undoOpts);
        undone.push(entry);
      } catch (error) {
        failed.push({ entry, error: error as Error });
      }
    }
    return { undone, failed };
  }

  /** Low-level request against the base URL. Not journaled. Retries rate limits and transient failures. */
  async request(
    method: HttpMethod,
    path: string,
    opts: {
      query?: Record<string, QueryValue>;
      body?: unknown;
      headers?: Record<string, string>;
      contentType?: string;
      /** Safe to retry after a timeout or 5xx. Defaults to true for GET, PUT and DELETE. */
      idempotent?: boolean;
    } = {},
  ): Promise<HttpResult> {
    const url = new URL(this.options.baseUrl.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    const base = typeof this.options.headers === 'function' ? await this.options.headers() : this.options.headers;
    // Configured headers (credentials) always win over per-call ones, whatever their case.
    const headers = mergeHeaders({ accept: 'application/json' }, opts.headers, base);
    // The body's own content type wins over a configured one (and multipart must set its own boundary).
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-type' && opts.body !== undefined) delete headers[k];
    const encoded = encodeBody(opts.body, opts.contentType);
    if (encoded.contentType) headers['content-type'] = encoded.contentType;
    const outgoing: OutgoingRequest = { method: method.toUpperCase(), url, headers, body: encoded.body };
    await this.options.beforeRequest?.(outgoing);

    const retries = this.options.retries ?? 2;
    const canRetry = opts.idempotent ?? ['get', 'put', 'delete'].includes(method);
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(outgoing.url, {
          method: outgoing.method,
          headers: outgoing.headers,
          body: outgoing.body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (canRetry && attempt < retries) {
          await sleep(this.backoff(attempt));
          continue;
        }
        const e = err as Error;
        throw new Error(
          e.name === 'TimeoutError'
            ? `${outgoing.method} ${outgoing.url.pathname} timed out after ${timeoutMs}ms`
            : `${outgoing.method} ${outgoing.url.pathname} failed: ${e.message}`,
        );
      }
      // 429, or a 403 that says when to retry (GitHub's secondary rate limits), means "slow down", not "forbidden".
      const rateLimited = res.status === 429 || (res.status === 403 && res.headers.has('retry-after'));
      const transient = rateLimited || ((res.status === 502 || res.status === 503 || res.status === 504) && canRetry);
      if (transient && attempt < retries) {
        await res.body?.cancel().catch(() => {});
        await sleep(retryAfterMs(res.headers.get('retry-after')) ?? this.backoff(attempt));
        continue;
      }
      const text = await res.text();
      let data: unknown = undefined;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => (outHeaders[k] = v));
      return { status: res.status, data, headers: outHeaders };
    }
  }

  /** The current id of a resource that may have been re-created by an undo. */
  remapId(param: string, id: Scalar): Scalar {
    let cur = id;
    for (let i = 0; i < 32; i++) {
      const next = this.idMap.get(param)?.get(String(cur));
      if (next === undefined) return cur;
      cur = next;
    }
    return cur;
  }

  /** Save an entry to the store, without bodies the undo doesn't need when journalDetail is 'minimal'. */
  private async persist(entry: JournalEntry) {
    if (!this.store) return;
    if (this.options.journalDetail !== 'minimal') return this.store.save(entry);
    const slim: JournalEntry = {
      ...entry,
      // Conflict checks only compare values: keep hashes, not the values.
      check: entry.check ? { ...entry.check, expected: hashValues(entry.check.expected, entry.session) } : undefined,
      // A reloaded minimal entry has no body any more: keep the refs it was saved with.
      request: { ...entry.request, body: undefined, bodyRefs: entry.request.body !== undefined ? bodyRefsOf(entry.request.body, entry.session) : entry.request.bodyRefs },
      response: { status: entry.response.status, data: undefined, headers: {} },
      before: undefined,
      undoResponse: entry.undoResponse ? { status: entry.undoResponse.status, data: undefined, headers: {} } : undefined,
    };
    return this.store.save(slim);
  }

  private backoff(attempt: number) {
    return (this.options.retryDelayMs ?? 250) * 2 ** attempt;
  }

  private async finish(target: JournalEntry, res: HttpResult): Promise<HttpResult> {
    target.status = 'undone';
    target.undone = true;
    target.undoError = undefined;
    await this.persist(target);
    return res;
  }

  private async conflict(target: JournalEntry, conflicts: Conflict[], res: HttpResult, cascaded: JournalEntry[] = []): Promise<never> {
    target.status = 'conflict';
    target.undoError = 'state changed since the call';
    await this.persist(target);
    const err = new ConflictError(target, conflicts, res);
    if (cascaded.length) err.message += ` The writes that depended on it were already undone: ${cascaded.map((d) => `#${d.seq} ${d.operationId}`).join(', ')}.`;
    throw err;
  }

  /** List each child collection (and, recursively, each child's own collections) before a delete. */
  private async captureChildren(plans: ChildPlan[], params: Record<string, Scalar>): Promise<CapturedChildren[]> {
    const out: CapturedChildren[] = [];
    for (const child of plans) {
      let path: string;
      try {
        path = fillPath(child.list.path, params);
      } catch {
        continue;
      }
      const res = await this.request('get', path);
      if (res.status >= 300 || !Array.isArray(res.data)) continue;
      const group: CapturedChildren = { plan: child, params: { ...params }, items: res.data };
      if (child.children?.length) {
        group.itemChildren = [];
        for (const item of res.data) {
          const id = getPath(item, child.idKey) as Scalar | undefined;
          group.itemChildren.push(id === undefined ? [] : await this.captureChildren(child.children, { ...params, [child.param]: id }));
        }
      }
      out.push(group);
    }
    return out;
  }

  private async restoreChildren(target: JournalEntry, groups: CapturedChildren[] = target.children ?? []) {
    const warnings: string[] = [];
    for (const group of groups) {
      const params = this.remapParams(group.params);
      for (const [index, item] of group.items.entries()) {
        const body = resolveBody(group.plan.create.body, { params, query: {}, before: item });
        let path: string;
        try {
          path = fillPath(group.plan.create.path, params);
        } catch (err) {
          warnings.push((err as Error).message);
          continue;
        }
        const op = this.ops.get(group.plan.create.operationId);
        const res = await this.request('post', path, { body, contentType: op?.requestContentType });
        if (res.status >= 300) {
          warnings.push(`re-creating a child with ${group.plan.create.operationId} failed: HTTP ${res.status}`);
          continue;
        }
        const oldId = getPath(item, group.plan.idKey) as Scalar | undefined;
        const newId = getPath(res.data, group.plan.idKey) as Scalar | undefined;
        if (oldId !== undefined && newId !== undefined) this.recordId(target, group.plan.param, oldId, newId);
        // Grandchildren: their captured params name the old child id, which now remaps to the new one.
        const nested = group.itemChildren?.[index];
        if (nested?.length) await this.restoreChildren(target, nested);
      }
    }
    if (warnings.length) target.undoWarnings = [...(target.undoWarnings ?? []), ...warnings];
  }

  private recordId(entry: JournalEntry, param: string, oldId: Scalar, newId: Scalar) {
    entry.idMap ??= {};
    (entry.idMap[param] ??= {})[String(oldId)] = newId;
    this.rememberId(param, String(oldId), newId);
  }

  private rememberId(param: string, oldId: string, newId: Scalar) {
    if (!this.idMap.has(param)) this.idMap.set(param, new Map());
    this.idMap.get(param)!.set(oldId, newId);
  }

  private remapParams(params: Record<string, Scalar>): Record<string, Scalar> {
    return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, this.remapId(k, v)]));
  }

  private remapRequest(req: ResolvedRequest): ResolvedRequest {
    if (!req.pathTemplate || !req.params) return req;
    const params = this.remapParams(req.params);
    return { ...req, params, path: fillPath(req.pathTemplate, params) };
  }

  private resolveRequest(template: RequestTemplate, sources: Sources): ResolvedRequest {
    const params = resolveParams(template, sources);
    return {
      operationId: template.operationId,
      method: template.method,
      path: fillPath(template.path, params),
      pathTemplate: template.path,
      params,
      query: resolveQuery(template, sources),
      body: resolveBody(template.body, sources),
      contentType: this.ops.get(template.operationId)?.requestContentType,
    };
  }
}

interface Sources {
  params: Record<string, Scalar>;
  query: Record<string, QueryValue>;
  response?: unknown;
  responseHeaders?: Record<string, string>;
  before?: unknown;
  request?: unknown;
}

export function getPath(obj: unknown, dotted: string): unknown {
  let cur: any = obj;
  for (const key of dotted.split('.')) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** The last path segment of a Location header, decoded (as sent, if it isn't valid percent-encoding). */
export function idFromLocation(location: string): string | undefined {
  const last = new URL(location, 'http://x').pathname.split('/').filter(Boolean).at(-1);
  if (!last) return undefined;
  try {
    return decodeURIComponent(last) || undefined;
  } catch {
    return last;
  }
}

/**
 * The binding that names the resource a create made: the inverse route's last
 * path parameter, when it comes from the response, the request (a client-chosen
 * id) or the Location header; otherwise the first response or Location binding
 * (RPC deletes that take the id in the body).
 */
export function createdBinding(template: Pick<RequestTemplate, 'path' | 'bindings'>): [string, ValueRef] | undefined {
  const last = [...template.path.matchAll(/\{([^}]+)\}/g)].at(-1)?.[1];
  const ref = last ? template.bindings[last] : undefined;
  if (last && ref && (ref.from === 'response' || ref.from === 'request' || ref.from === 'location')) return [last, ref];
  return Object.entries(template.bindings).find(([, r]) => r.from === 'response' || r.from === 'location');
}

function lookup(ref: ValueRef, sources: Sources): unknown {
  if (ref.from === 'location') {
    const loc = sources.responseHeaders?.['location'];
    return loc ? idFromLocation(loc) : undefined;
  }
  return getPath(sources[ref.from], ref.key);
}

export function fillPath(path: string, params: Record<string, unknown>): string {
  return path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined || v === null) throw new Error(`Missing path parameter "${name}" for ${path}`);
    const s = String(v);
    // "." and ".." survive encodeURIComponent and are collapsed by URL parsing (and by many servers),
    // which would send the request to a different route than the operation that was approved.
    if (s === '' || s === '.' || s === '..') throw new Error(`Path parameter "${name}" for ${path} must not be ${s ? `"${s}"` : 'empty'}`);
    return encodeURIComponent(s);
  });
}

function resolveParams(template: RequestTemplate, sources: Sources): Record<string, Scalar> {
  const values: Record<string, Scalar> = {};
  for (const [name, ref] of Object.entries(template.bindings)) {
    const v = lookup(ref, sources);
    if (v === undefined || v === null) {
      throw new Error(`Cannot resolve {${name}} from ${ref.from}${ref.key ? '.' + ref.key : ''}`);
    }
    values[name] = v as Scalar;
  }
  return values;
}

function resolvePath(template: RequestTemplate, sources: Sources): string {
  return fillPath(template.path, resolveParams(template, sources));
}

function resolveQuery(template: RequestTemplate, sources: Sources): Record<string, QueryValue> | undefined {
  if (!template.query) return undefined;
  const out: Record<string, QueryValue> = {};
  for (const [name, ref] of Object.entries(template.query)) {
    const v = lookup(ref, sources);
    if (v !== undefined && v !== null) out[name] = v as QueryValue;
  }
  return Object.keys(out).length ? out : undefined;
}

const looseKey = (k: string) => k.toLowerCase().replace(/[-_\s]/g, '');

/**
 * Read a field, tolerating case and separator differences: APIs like Twilio take
 * form fields as FriendlyName but return JSON as friendly_name.
 */
export function looseGet(obj: unknown, key: string): { found: boolean; value?: unknown } {
  if (!obj || typeof obj !== 'object') return { found: false };
  const o = obj as Record<string, unknown>;
  if (key in o) return { found: true, value: o[key] };
  const want = looseKey(key);
  const match = Object.keys(o).find((k) => looseKey(k) === want);
  return match === undefined ? { found: false } : { found: true, value: o[match] };
}

function pick(obj: unknown, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of keys) if (k in (obj as object)) out[k] = (obj as Record<string, unknown>)[k];
  return out;
}

function resolveBody(body: BodyTemplate | undefined, sources: Sources): unknown {
  if (!body) return undefined;
  switch (body.from) {
    case 'request':
      return body.fields ? pick(sources.request, body.fields) : sources.request;
    case 'literal':
      return body.value;
    case 'fields': {
      const out: Record<string, unknown> = {};
      for (const [k, ref] of Object.entries(body.fields)) {
        const v = lookup(ref, sources);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    case 'before':
      if (sources.before == null) throw new Error('No captured state to restore from');
      return body.fields === '*' ? sources.before : pick(sources.before, body.fields);
    case 'before-request-keys': {
      if (sources.before == null) throw new Error('No captured state to restore from');
      return restoreSent(sources.request, sources.before, !!body.nullMissing);
    }
    case 'before-json-patch':
      if (sources.before == null) throw new Error('No captured state to restore from');
      return invertJsonPatch(sources.request, sources.before);
  }
}

/** A value that looks like an identifier rather than a word: 8+ characters with a digit, dash or underscore. */
const idLike = (v: string) => v.length >= 8 && /[\d_-]/.test(v);

const refHash = (id: string, salt: string) => createHash('sha256').update(`${salt}\u0000${id}`).digest('hex').slice(0, 32);

/** Hashes of the id-like values (4+ characters) in a body, a few levels deep. */
function bodyRefsOf(body: unknown, salt: string): string[] | undefined {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 3 || v === null || v === undefined) return;
    if ((typeof v === 'string' || typeof v === 'number') && String(v).length >= 4) out.add(refHash(String(v), salt));
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (typeof v === 'object') Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(body, 0);
  return out.size ? [...out] : undefined;
}

/** Merge header maps, later ones winning, matching names case-insensitively. */
function mergeHeaders(...layers: Array<Record<string, string> | undefined>): Record<string, string> {
  const out = new Map<string, [string, string]>();
  for (const layer of layers) for (const [k, v] of Object.entries(layer ?? {})) out.set(k.toLowerCase(), [k, v]);
  return Object.fromEntries([...out.values()]);
}

/** Whether any string value in a request body (a few levels deep) is one of `ids`. */
function bodyMentions(body: unknown, ids: string[], depth = 0): boolean {
  if (depth > 3 || body === null || body === undefined) return false;
  if (typeof body === 'string' || typeof body === 'number') return ids.includes(String(body));
  if (Array.isArray(body)) return body.some((x) => bodyMentions(x, ids, depth + 1));
  if (typeof body === 'object') return Object.values(body).some((x) => bodyMentions(x, ids, depth + 1));
  return false;
}

/** Fields that change on every write and say nothing about who changed what. */
export const VOLATILE_FIELDS = [
  'createdAt', 'updatedAt', 'created_at', 'updated_at', 'modifiedAt', 'modified_at',
  'lastModified', 'last_modified', 'etag', 'ETag',
];

/** A response as comparable fields; "(status)" carries the HTTP status (for resources that toggle between 204 and 404). */
function stateOf(res: HttpResult): Record<string, unknown> {
  const data = res.data && typeof res.data === 'object' && !Array.isArray(res.data) && res.status < 300 ? (res.data as Record<string, unknown>) : {};
  return { '(status)': res.status, ...data };
}

/** The fields that differ between two reads, with their new values. */
function changedState(before: HttpResult, after: HttpResult): Record<string, unknown> {
  if (before.status !== after.status) return { '(status)': after.status };
  const a = stateOf(before);
  const b = stateOf(after);
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (VOLATILE_FIELDS.includes(k)) continue;
    if (stableStringify(a[k]) !== stableStringify(b[k])) out[k] = b[k];
  }
  return out;
}

const unescapePointer = (s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~');
const escapePointer = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');

/** Top-level members an RFC 6902 patch touches (targets, and the sources of move). */
export function jsonPatchMembers(patch: unknown): string[] | undefined {
  if (!Array.isArray(patch) || !patch.every((o) => o && typeof o === 'object' && typeof o.op === 'string' && typeof o.path === 'string')) return undefined;
  const out: string[] = [];
  for (const o of patch as Array<{ op: string; path: string; from?: string }>) {
    for (const p of [o.path, ...(o.op === 'move' && typeof o.from === 'string' ? [o.from] : [])]) {
      const member = p === '' ? '' : unescapePointer(p.split('/')[1] ?? '');
      if (!out.includes(member)) out.push(member);
    }
  }
  return out;
}

/**
 * The inverse of a JSON Patch: put back every top-level member it touched, as it was.
 * `add` restores a member whether or not it still exists; members that did not exist are removed.
 */
export function invertJsonPatch(patch: unknown, before: unknown): unknown[] {
  const members = jsonPatchMembers(patch);
  if (!members) throw new Error('The request body is not a JSON Patch');
  if (members.includes('')) return [{ op: 'replace', path: '', value: before }];
  const prior = (before && typeof before === 'object' ? before : {}) as Record<string, unknown>;
  return members.map((m) => (m in prior ? { op: 'add', path: `/${escapePointer(m)}`, value: prior[m] } : { op: 'remove', path: `/${escapePointer(m)}` }));
}

/**
 * What the call left behind, as far as the caller can know: the top-level keys it sent,
 * with the values the server reported back (or the sent values when it reported nothing).
 * For creates, only keys the server echoed back are expected.
 */
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ENVELOPE_NAMES = new Set(['data', 'attributes']);
const ENVELOPE_SIBLINGS = new Set(['meta', 'links', 'included', 'jsonapi', 'errors']);

/**
 * Keys of `body` that wrap the resource rather than being a field of it: JSON:API's data/attributes,
 * or a single key holding the whole representation (Asana { data: {...} }, Rails { task: {...} }).
 * A field like { settings: {...} } next to other fields is not an envelope.
 */
function envelopeKeys(body: Record<string, unknown>, state: unknown): Set<string> {
  const out = new Set<string>();
  if (!isPlainObject(state)) return out;
  const keys = Object.keys(body);
  for (const k of keys) {
    const hit = looseGet(state, k);
    if (!isPlainObject(body[k]) || !isPlainObject(hit.value)) continue;
    const wrapsAll = keys.length === 1 && Object.keys(state).every((x) => looseGet({ [x]: 0 }, k).found || ENVELOPE_SIBLINGS.has(x));
    if (ENVELOPE_NAMES.has(k) || wrapsAll) out.add(k);
  }
  return out;
}

/** The previous values of exactly the fields `request` sent, following envelopes into nested objects. */
function restoreSent(request: unknown, before: unknown, nullMissing: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(request)) return out;
  const nested = envelopeKeys(request, before);
  for (const k of Object.keys(request)) {
    const hit = looseGet(before, k);
    if (nested.has(k)) out[k] = restoreSent(request[k], hit.value, nullMissing);
    else if (hit.found) out[k] = hit.value;
    else if (nullMissing) out[k] = null; // merge patch: null removes the key the call added
  }
  return out;
}

function expectedState(request: unknown, response: unknown, onlyEchoed: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const patched = jsonPatchMembers(request);
  if (patched && response && typeof response === 'object' && !Array.isArray(response)) {
    // A JSON Patch: expect the members it touched to still look the way the response showed them.
    for (const m of patched) if (m) out[m] = (response as Record<string, unknown>)[m];
    return out;
  }
  if (!isPlainObject(request)) return out;
  const res = isPlainObject(response) ? response : undefined;
  const nested = envelopeKeys(request, res);
  for (const [k, v] of Object.entries(request)) {
    const hit = looseGet(res, k);
    if (nested.has(k)) {
      const inner = expectedState(v, hit.value, onlyEchoed);
      if (Object.keys(inner).length) out[k] = inner;
    } else if (hit.found) out[k] = hit.value;
    else if (!onlyEchoed) out[k] = v;
  }
  return out;
}

const HASHED = '$undogenSha256';

/** Replace expected values by salted hashes (journalDetail 'minimal'): enough to compare, not to read. */
function hashValues(expected: Record<string, unknown>, salt: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(expected)) {
    if (isPlainObject(v) && HASHED in v) out[k] = v; // already hashed (an entry saved again)
    else out[k] = isPlainObject(v) ? hashValues(v, salt) : { [HASHED]: createHash('sha256').update(salt + stableStringify(v)).digest('hex') };
  }
  return out;
}

/** Whether a (hashed) expected value holds hash leaves at any depth, so it must be compared leaf by leaf. */
function containsHash(v: unknown): boolean {
  return isPlainObject(v) && (HASHED in v || Object.values(v).some(containsHash));
}

function compareExpected(expected: Record<string, unknown>, current: unknown, prefix = '', salt = ''): Conflict[] {
  const cur = isPlainObject(current) ? current : {};
  const nested = envelopeKeys(expected, cur);
  const out: Conflict[] = [];
  for (const [field, value] of Object.entries(expected)) {
    const actual = looseGet(cur, field).value;
    if (isPlainObject(value) && HASHED in value) {
      const h = createHash('sha256').update(salt + stableStringify(actual)).digest('hex');
      if (h !== value[HASHED]) out.push({ field: prefix + field, expected: '(hidden: journalDetail is minimal)', actual });
    } else if (nested.has(field) || containsHash(value)) {
      out.push(...compareExpected(value as Record<string, unknown>, actual, `${prefix}${field}.`, salt));
    } else if (stableStringify(actual) !== stableStringify(value)) out.push({ field: prefix + field, expected: value, actual });
  }
  return out;
}

export function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_, x) =>
    // Code-point order (like Python's sort_keys), so hashes and fingerprints agree across runtimes.
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  ) ?? 'undefined';
}

function fingerprintOf(operationId: string, input: CallInput): string {
  const h = createHash('sha256');
  h.update(stableStringify({ operationId, params: input.params ?? {}, query: input.query ?? {}, body: input.body ?? null }));
  return h.digest('hex').slice(0, 32);
}

function encodeBody(body: unknown, contentType?: string): { body?: string | URLSearchParams | FormData; contentType?: string } {
  if (body === undefined) return {};
  const ct = contentType ?? 'application/json';
  if (/x-www-form-urlencoded/i.test(ct)) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries((body ?? {}) as Record<string, unknown>)) {
      for (const item of Array.isArray(v) ? v : [v]) {
        if (item !== undefined) form.append(k, typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item));
      }
    }
    return { body: form, contentType: 'application/x-www-form-urlencoded' };
  }
  if (/multipart\/form-data/i.test(ct)) {
    const form = new FormData();
    for (const [k, v] of Object.entries((body ?? {}) as Record<string, unknown>)) {
      for (const item of Array.isArray(v) ? v : [v]) {
        if (item === undefined) continue;
        if (item instanceof Blob) form.append(k, item);
        else form.append(k, typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item));
      }
    }
    return { body: form }; // fetch sets the multipart boundary
  }
  if (/^text\//i.test(ct)) return { body: String(body), contentType: ct };
  return { body: JSON.stringify(body), contentType: /json/i.test(ct) ? ct : 'application/json' };
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), 60_000) : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
