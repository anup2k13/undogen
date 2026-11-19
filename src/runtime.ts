import { analyze } from './analyze.js';
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
  path: string;
  body?: unknown;
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
  undone: boolean;
  undoResponse?: HttpResult;
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

export interface ClientOptions {
  spec: ApiSpec;
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
}

/**
 * An HTTP client for an OpenAPI-described API that journals every write
 * together with the request that undoes it.
 */
export class UndoableClient {
  readonly journal: JournalEntry[] = [];
  private readonly ops: Map<string, Operation>;
  private readonly plans: Map<string, InversePlan>;
  private readonly fetchImpl: typeof fetch;
  private seq = 0;

  constructor(private readonly options: ClientOptions) {
    this.ops = new Map(options.spec.operations.map((o) => [o.id, o]));
    const plans = options.plans ?? analyze(options.spec).plans;
    this.plans = new Map(plans.map((p) => [p.operationId, p]));
    this.fetchImpl = options.fetch ?? fetch;
  }

  planFor(operationId: string): InversePlan | undefined {
    return this.plans.get(operationId);
  }

  /** Call an operation by operationId. Writes are journaled with their inverse. */
  async call(operationId: string, input: CallInput = {}): Promise<HttpResult & { entry?: JournalEntry }> {
    const op = this.ops.get(operationId);
    if (!op) throw new Error(`Unknown operation: ${operationId}`);
    const params = input.params ?? {};

    if (op.method === 'get') return this.request(op.method, fillPath(op.path, params), { query: input.query });

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
      const snap = await this.request('get', resolvePath(plan.capture, { params }));
      if (snap.status === 404) before = null;
      else if (snap.status < 300) before = snap.data ?? {};
      else throw new Error(`Capture before ${operationId} failed: HTTP ${snap.status}`);
      captured = true;
    }

    const path = fillPath(op.path, params);
    const response = await this.request(op.method, path, { query: input.query, body: input.body });
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
          path: resolvePath(template, sources),
          body: resolveBody(template.body, sources),
        };
      } catch (err) {
        inverseError = (err as Error).message;
      }
    } else if (plan.strategy !== 'no-side-effects') {
      inverseError = 'No inverse for this operation';
    }

    const entry: JournalEntry = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      operationId,
      request: { operationId, method: op.method, path, body: input.body },
      response,
      before: captured ? before : undefined,
      plan: { reversibility: plan.reversibility, strategy: plan.strategy, confidence: plan.confidence },
      inverse,
      inverseError,
      undone: false,
    };
    this.journal.push(entry);
    return { ...response, entry };
  }

  /** Undo one entry (default: the most recent one not yet undone). */
  async undo(entry?: JournalEntry): Promise<HttpResult> {
    const target = entry ?? [...this.journal].reverse().find((e) => !e.undone);
    if (!target) throw new Error('Nothing to undo');
    if (target.undone) throw new UndoError(`Entry #${target.seq} is already undone`, target);
    if (!target.inverse && target.plan.strategy === 'no-side-effects') {
      target.undone = true;
      return { status: 204, data: undefined, headers: {} };
    }
    if (!target.inverse) {
      throw new UndoError(`Entry #${target.seq} (${target.operationId}) cannot be undone: ${target.inverseError}`, target);
    }
    const res = await this.request(target.inverse.method, target.inverse.path, { body: target.inverse.body });
    target.undoResponse = res;
    if (res.status >= 400 && !(target.inverse.method === 'delete' && res.status === 404)) {
      throw new UndoError(
        `Undo of #${target.seq} (${target.operationId}) failed: ${target.inverse.method.toUpperCase()} ${target.inverse.path} -> HTTP ${res.status}`,
        target,
        res,
      );
    }
    target.undone = true;
    return res;
  }

  /** Undo everything in reverse order (a saga rollback). Continues past failures and reports them. */
  async undoAll(): Promise<{ undone: JournalEntry[]; failed: Array<{ entry: JournalEntry; error: Error }> }> {
    const undone: JournalEntry[] = [];
    const failed: Array<{ entry: JournalEntry; error: Error }> = [];
    for (const entry of [...this.journal].reverse()) {
      if (entry.undone) continue;
      try {
        await this.undo(entry);
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
    opts: { query?: CallInput['query']; body?: unknown } = {},
  ): Promise<HttpResult> {
    const url = new URL(this.options.baseUrl.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: 'application/json', ...this.options.headers };
    let body: string | undefined;
    if (opts.body !== undefined) {
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

function resolveBody(body: BodyTemplate | undefined, sources: Sources): unknown {
  if (!body) return undefined;
  switch (body.from) {
    case 'request':
      return sources.request;
    case 'literal':
      return body.value;
    case 'before':
      if (sources.before == null) throw new Error('No captured state to restore from');
      return body.fields === '*' ? sources.before : pick(sources.before, body.fields);
    case 'before-request-keys': {
      if (sources.before == null) throw new Error('No captured state to restore from');
      const keys = sources.request && typeof sources.request === 'object' ? Object.keys(sources.request) : [];
      return pick(sources.before, keys);
    }
  }
}
