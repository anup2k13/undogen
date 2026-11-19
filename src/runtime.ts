import { analyze } from './analyze.js';
import { DEFAULT_IGNORED_FIELDS, diffValues, type StateDiff } from './diff.js';
import { appendJournalEvent, readJournal } from './journal.js';
import type { ApiSpec, BodyTemplate, HttpMethod, InversePlan, Operation, RequestTemplate, ValueRef } from './types.js';

export interface CallInput {
  params?: Record<string, string | number>;
  query?: Record<string, string | number | boolean>;
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
  /** Full path, including any basePath. */
  path: string;
  body?: unknown;
  /** Set when the body must be sent form-encoded. */
  format?: 'form';
}

export interface JournalEntry {
  seq: number;
  at: string;
  operationId: string;
  request: ResolvedRequest;
  response: HttpResult;
  /** State captured before the call; `null` means the resource did not exist. */
  before?: unknown;
  plan: Pick<InversePlan, 'reversibility' | 'strategy' | 'confidence'>;
  /** The concrete request that undoes this entry, resolved at call time. */
  inverse: ResolvedRequest | null;
  /** Why `inverse` is null, if it is. */
  inverseError?: string;
  /**
   * Safe-undo guard: the resource as it looked right after this write.
   * Undo compares it with the live state and refuses if someone changed it since.
   */
  guard?: { path: string; after: unknown };
  undone: boolean;
  undoResponse?: HttpResult;
}

export interface UndoOptions {
  /** Undo even if the resource changed after the agent's write (overwrites those changes). */
  force?: boolean;
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

export class UndoError extends Error {
  constructor(message: string, public readonly entry: JournalEntry, public readonly response?: HttpResult) {
    super(message);
    this.name = 'UndoError';
  }
}

/** Someone (or something) changed the resource after the agent's write; undoing would clobber it. */
export class UndoConflictError extends UndoError {
  constructor(entry: JournalEntry, public readonly diffs: StateDiff[]) {
    const detail = diffs
      .slice(0, 3)
      .map((d) => `${d.path}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`)
      .join('; ');
    super(
      `Refusing to undo #${entry.seq} (${entry.operationId}): ${entry.guard?.path} changed after the write (${detail}). ` +
        'Pass { force: true } to overwrite those changes.',
      entry,
    );
    this.name = 'UndoConflictError';
  }
}

export interface ClientOptions {
  /** Needed to make calls. Undoing entries from a journal works without it. */
  spec?: ApiSpec;
  baseUrl: string;
  /** Pre-compiled plans; compiled from `spec` when omitted. */
  plans?: InversePlan[];
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /**
   * Gate for operations that cannot be undone. `false` (default) blocks them;
   * a function lets a human or policy engine approve case by case.
   */
  allowIrreversible?: boolean | ((op: Operation, plan: InversePlan, input: CallInput) => boolean | Promise<boolean>);
  /** Fields that may change without counting as a conflict (default: timestamps, etags). */
  ignoreFields?: string[];
  /**
   * Append every write and undo to this JSON Lines file. Use UndoableClient.open()
   * to resume a journal, e.g. to roll back from a different process later.
   * The journal contains request and response bodies: treat it as sensitive.
   */
  journalFile?: string;
}

/**
 * An HTTP client for an OpenAPI-described API that journals every write
 * together with the request that undoes it.
 */
export class UndoableClient {
  readonly journal: JournalEntry[] = [];
  /** Prefix added to every route (the spec's basePath, unless baseUrl already ends with it). */
  readonly basePath: string;
  private readonly ops: Map<string, Operation>;
  private readonly plans: Map<string, InversePlan>;
  private readonly fetchImpl: typeof fetch;
  private seq = 0;

  constructor(private readonly options: ClientOptions) {
    this.ops = new Map((options.spec?.operations ?? []).map((o) => [o.id, o]));
    const plans = options.plans ?? (options.spec ? analyze(options.spec).plans : []);
    this.plans = new Map(plans.map((p) => [p.operationId, p]));
    this.fetchImpl = options.fetch ?? fetch;
    const base = (options.spec?.basePath ?? '').replace(/\/+$/, '');
    const urlPath = new URL(options.baseUrl).pathname.replace(/\/+$/, '');
    this.basePath = base && !urlPath.endsWith(base) ? base : '';
  }

  private formatOf(operationId: string): 'form' | undefined {
    return this.ops.get(operationId)?.requestFormat === 'form' ? 'form' : undefined;
  }

  /** Create a client and load any entries already recorded in `options.journalFile`. */
  static async open(options: ClientOptions): Promise<UndoableClient> {
    const client = new UndoableClient(options);
    if (options.journalFile) {
      const entries = await readJournal(options.journalFile);
      client.journal.push(...entries);
      client.seq = entries.reduce((max, e) => Math.max(max, e.seq), 0);
    }
    return client;
  }

  planFor(operationId: string): InversePlan | undefined {
    return this.plans.get(operationId);
  }

  /** Call an operation by operationId. Writes are journaled with their inverse. */
  async call(operationId: string, input: CallInput = {}): Promise<HttpResult & { entry?: JournalEntry }> {
    const op = this.ops.get(operationId);
    if (!op) throw new Error(`Unknown operation: ${operationId}`);
    const params = input.params ?? {};

    if (op.method === 'get') return this.request(op.method, this.basePath + fillPath(op.path, params), { query: input.query });

    const plan = this.plans.get(operationId);
    if (!plan) throw new Error(`No undo plan for ${operationId}`);

    if (plan.reversibility === 'irreversible' || plan.reversibility === 'unknown') {
      const gate = this.options.allowIrreversible ?? false;
      const approved = typeof gate === 'function' ? await gate(op, plan, input) : gate;
      if (!approved) throw new IrreversibleOperationError(operationId, plan);
    }

    // Capture state before the write.
    let before: unknown;
    let captured = false;
    if (plan.capture) {
      const snap = await this.request('get', this.basePath + resolvePath(plan.capture, { params }));
      if (snap.status === 404) before = null;
      else if (snap.status < 300) before = snap.data ?? {};
      else throw new Error(`Capture before ${operationId} failed: HTTP ${snap.status}`);
      captured = true;
    }

    const path = this.basePath + fillPath(op.path, params);
    const format = this.formatOf(op.id);
    const response = await this.request(op.method, path, { query: input.query, body: input.body, format });
    if (response.status >= 400) return response; // nothing happened, nothing to undo

    const sources: Sources = { params, response: response.data, before, request: input.body };
    const template = captured && before === null && plan.inverseIfMissing ? plan.inverseIfMissing : plan.inverse;
    let inverse: ResolvedRequest | null = null;
    let inverseError: string | undefined;
    if (template) {
      try {
        inverse = {
          operationId: template.operationId,
          method: template.method,
          path: this.basePath + resolvePath(template, sources),
          body: resolveBody(template.body, sources),
          ...(this.formatOf(template.operationId) ? { format: 'form' as const } : {}),
        };
      } catch (err) {
        inverseError = (err as Error).message;
      }
    } else if (plan.strategy !== 'no-side-effects') {
      inverseError = 'No inverse for this operation';
    }

    // Remember what the resource looks like now, so undo can detect later changes.
    let guard: JournalEntry['guard'];
    if (plan.guard && inverse) {
      try {
        const guardPath = this.basePath + resolvePath(plan.guard, sources);
        const after = await this.request('get', guardPath);
        if (after.status < 300) guard = { path: guardPath, after: after.data ?? {} };
      } catch {
        /* no guard: undo still works, just without conflict detection */
      }
    }

    const entry: JournalEntry = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      operationId,
      request: { operationId, method: op.method, path, body: input.body, ...(format ? { format } : {}) },
      response,
      before: captured ? before : undefined,
      plan: { reversibility: plan.reversibility, strategy: plan.strategy, confidence: plan.confidence },
      inverse,
      inverseError,
      guard,
      undone: false,
    };
    this.journal.push(entry);
    if (this.options.journalFile) await appendJournalEvent(this.options.journalFile, { type: 'write', entry });
    return { ...response, entry };
  }

  /** Undo one entry (default: the most recent one not yet undone). Accepts an entry or its seq number. */
  async undo(entry?: JournalEntry | number, options: UndoOptions = {}): Promise<HttpResult> {
    const target =
      typeof entry === 'number'
        ? this.journal.find((e) => e.seq === entry)
        : entry ?? [...this.journal].reverse().find((e) => !e.undone);
    if (!target && typeof entry === 'number') throw new Error(`No journal entry #${entry}`);
    if (!target) throw new Error('Nothing to undo');
    if (target.undone) throw new UndoError(`Entry #${target.seq} is already undone`, target);
    if (!target.inverse && target.plan.strategy === 'no-side-effects') {
      return this.markUndone(target, { status: 204, data: undefined, headers: {} }, options);
    }
    if (!target.inverse) {
      throw new UndoError(`Entry #${target.seq} (${target.operationId}) cannot be undone: ${target.inverseError}`, target);
    }
    if (target.inverse.path.startsWith('mcp:')) {
      throw new UndoError(
        `Entry #${target.seq} (${target.operationId}) was recorded by \`undogen wrap\`; undo it with the undogen_undo tool of the wrapped MCP server`,
        target,
      );
    }
    if (target.guard && !options.force) {
      const live = await this.request('get', target.guard.path);
      if (live.status === 404) {
        if (target.inverse.method === 'delete') {
          // Already gone: the undo's goal is reached without touching anything.
          return this.markUndone(target, live, options);
        }
        throw new UndoConflictError(target, [{ resource: `GET ${target.guard.path}`, path: 'status', before: 200, after: 404 }]);
      }
      const ignore = new Set(this.options.ignoreFields ?? DEFAULT_IGNORED_FIELDS);
      const diffs = diffValues(target.guard.after, live.data ?? {}, { ignore }, `GET ${target.guard.path}`);
      if (diffs.length) throw new UndoConflictError(target, diffs);
    }
    const res = await this.request(target.inverse.method, target.inverse.path, { body: target.inverse.body, format: target.inverse.format });
    target.undoResponse = res;
    if (res.status >= 400 && !(target.inverse.method === 'delete' && res.status === 404)) {
      throw new UndoError(
        `Undo of #${target.seq} (${target.operationId}) failed: ${target.inverse.method.toUpperCase()} ${target.inverse.path} -> HTTP ${res.status}`,
        target,
        res,
      );
    }
    return this.markUndone(target, res, options);
  }

  private async markUndone(entry: JournalEntry, res: HttpResult, options: UndoOptions): Promise<HttpResult> {
    entry.undone = true;
    entry.undoResponse = res;
    if (this.options.journalFile) {
      await appendJournalEvent(this.options.journalFile, {
        type: 'undo',
        seq: entry.seq,
        at: new Date().toISOString(),
        response: res,
        ...(options.force ? { forced: true } : {}),
      });
    }
    return res;
  }

  /** Undo everything in reverse order (a saga rollback). Continues past failures and reports them. */
  async undoAll(options: UndoOptions = {}): Promise<{ undone: JournalEntry[]; failed: Array<{ entry: JournalEntry; error: Error }> }> {
    const undone: JournalEntry[] = [];
    const failed: Array<{ entry: JournalEntry; error: Error }> = [];
    for (const entry of [...this.journal].reverse()) {
      if (entry.undone) continue;
      try {
        await this.undo(entry, options);
        undone.push(entry);
      } catch (error) {
        failed.push({ entry, error: error as Error });
      }
    }
    return { undone, failed };
  }

  /** Low-level request against the base URL. Not journaled. */
  async request(
    method: HttpMethod,
    path: string,
    opts: { query?: CallInput['query']; body?: unknown; format?: 'json' | 'form' } = {},
  ): Promise<HttpResult> {
    const url = new URL(this.options.baseUrl.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: 'application/json', ...this.options.headers };
    let body: string | undefined;
    if (opts.body !== undefined && opts.format === 'form') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries((opts.body ?? {}) as Record<string, unknown>)) {
        if (v !== undefined && v !== null) form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      body = form.toString();
    } else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await this.fetchImpl(url, { method: method.toUpperCase(), headers, body });
    const text = await res.text();
    let data: unknown = text;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        /* keep text */
      }
    } else data = undefined;
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => (outHeaders[k] = v));
    return { status: res.status, data, headers: outHeaders };
  }
}

interface Sources {
  params: Record<string, string | number>;
  response?: unknown;
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

function lookup(ref: ValueRef, sources: Sources): unknown {
  return getPath(sources[ref.from], ref.key);
}

export function fillPath(path: string, params: Record<string, unknown>): string {
  return path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined || v === null) throw new Error(`Missing path parameter "${name}" for ${path}`);
    return encodeURIComponent(String(v));
  });
}

function resolvePath(template: RequestTemplate, sources: Sources): string {
  const values: Record<string, unknown> = {};
  for (const [name, ref] of Object.entries(template.bindings)) {
    const v = lookup(ref, sources);
    if (v === undefined || v === null) {
      throw new Error(`Cannot resolve {${name}} from ${ref.from}.${ref.key}`);
    }
    values[name] = v;
  }
  return fillPath(template.path, values);
}

function pick(obj: unknown, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of keys) if (k in (obj as object)) out[k] = (obj as Record<string, unknown>)[k];
  return out;
}

/**
 * Fields the server owns. Sending them back from a snapshot makes restores fail
 * (a stale resourceVersion is a 409 in Kubernetes; a uid on create is rejected).
 */
export const SERVER_MANAGED_FIELDS = new Set([
  'resourceVersion', 'uid', 'creationTimestamp', 'deletionTimestamp', 'deletionGracePeriodSeconds',
  'generation', 'managedFields', 'selfLink', '_rev', 'etag', 'ETag',
]);

function stripServerManaged(value: unknown, depth = 0): unknown {
  if (depth > 32 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripServerManaged(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!SERVER_MANAGED_FIELDS.has(k)) out[k] = stripServerManaged(v, depth + 1);
  }
  return out;
}

function resolveBody(body: BodyTemplate | undefined, sources: Sources): unknown {
  if (!body) return undefined;
  switch (body.from) {
    case 'request':
      return sources.request;
    case 'literal':
      return body.value;
    case 'before':
      if (sources.before == null) throw new Error('No captured state to restore from');
      return stripServerManaged(body.fields === '*' ? sources.before : pick(sources.before, body.fields));
    case 'before-request-keys': {
      if (sources.before == null) throw new Error('No captured state to restore from');
      const keys = sources.request && typeof sources.request === 'object' ? Object.keys(sources.request) : [];
      return stripServerManaged(pick(sources.before, keys));
    }
  }
}
