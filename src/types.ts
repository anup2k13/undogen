export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** The subset of JSON Schema that undogen reasons about. */
export interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  example?: unknown;
  default?: unknown;
  readOnly?: boolean;
  format?: string;
  [key: string]: unknown;
}

/** One HTTP operation from the OpenAPI document, with $refs resolved. */
export interface Operation {
  /** operationId, or "METHOD /path" when the spec does not declare one. */
  id: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  pathParams: string[];
  requestSchema?: Schema;
  requestExample?: unknown;
  responseSchema?: Schema;
  /** Vendor extensions (x-*) declared on the operation. */
  extensions: Record<string, unknown>;
}

export interface ApiSpec {
  title: string;
  version: string;
  operations: Operation[];
}

/**
 * - reversible:   the inverse restores the exact prior state, identifiers included.
 * - compensable:  the inverse restores equivalent state, but identifiers change
 *                 (e.g. a deleted record is re-created under a new id).
 * - irreversible: no inverse exists (sending an email, moving money, ...).
 * - unknown:      undogen could not derive an inverse from the spec.
 */
export type Reversibility = 'reversible' | 'compensable' | 'irreversible' | 'unknown';

export type Strategy =
  | 'delete-created'
  | 'restore-snapshot'
  | 'recreate-from-snapshot'
  | 'paired-action'
  | 'toggle'
  | 'soft-delete'
  | 'no-side-effects'
  | 'declared'
  | 'none';

/** Where a value used by an inverse request comes from at runtime. */
export interface ValueRef {
  from: 'params' | 'response' | 'before' | 'request';
  /** Dotted path into the source object, e.g. "id" or "data.id". */
  key: string;
}

export type BodyTemplate =
  /** Fields copied from the state captured before the original call. '*' = all fields. */
  | { from: 'before'; fields: string[] | '*' }
  /** Copy from `before` exactly the keys that the original request body sent. */
  | { from: 'before-request-keys' }
  | { from: 'request' }
  /** A fixed body, e.g. { state: 'closed' } for soft deletes. */
  | { from: 'literal'; value: unknown };

/**
 * How a spec author (x-undogen) or a third party (overrides file) declares
 * an operation's undo behaviour. Bindings use "source.key" strings, e.g.
 * { repo: 'response.name', owner: 'response.owner.login' }.
 */
export interface Declaration {
  reversibility?: Reversibility;
  reason?: string;
  inverse?: string;
  bindings?: Record<string, string>;
  body?: 'before' | 'request' | { literal: unknown };
}

export interface RequestTemplate {
  operationId: string;
  method: HttpMethod;
  path: string;
  bindings: Record<string, ValueRef>;
  body?: BodyTemplate;
}

/** The compiled undo recipe for one mutating operation. */
export interface InversePlan {
  operationId: string;
  method: HttpMethod;
  path: string;
  reversibility: Reversibility;
  strategy: Strategy;
  /** 0..1: how sure the compiler is, before verification. */
  confidence: number;
  /** Request that captures state before the original call runs. */
  capture?: RequestTemplate;
  /** Request that undoes the original call. */
  inverse?: RequestTemplate;
  /** Alternate inverse when the capture found nothing (e.g. PUT that created a resource). */
  inverseIfMissing?: RequestTemplate;
  /**
   * Read used for safe undo: the state it returns right after the write is
   * remembered, and undo refuses to run if someone else has changed it since.
   */
  guard?: RequestTemplate;
  reasons: string[];
  caveats: string[];
}

export interface Analysis {
  spec: { title: string; version: string };
  plans: InversePlan[];
  summary: Record<Reversibility, number> & { total: number; readOnly: number };
}
