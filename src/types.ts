export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** The subset of JSON Schema that undogen reasons about. */
export interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  example?: unknown;
  examples?: unknown;
  default?: unknown;
  readOnly?: boolean;
  format?: string;
  [key: string]: unknown;
}

/** A non-body parameter of an operation (query, header, path or cookie). */
export interface Parameter {
  name: string;
  in: 'query' | 'header' | 'path' | 'cookie';
  required: boolean;
  schema?: Schema;
}

/** One HTTP operation from the OpenAPI document, with $refs resolved. */
export interface Operation {
  /** operationId, or "METHOD /path" when the spec does not declare one. */
  id: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  /** OpenAPI tags, e.g. ["issues"]. */
  tags: string[];
  /** Marked deprecated in the description. */
  deprecated?: boolean;
  pathParams: string[];
  /** Query parameters (path-level and operation-level, merged). */
  queryParams: Parameter[];
  /** Header parameters (path-level and operation-level, merged). */
  headerParams: Parameter[];
  requestSchema?: Schema;
  requestExample?: unknown;
  /** Media type of the request body, e.g. application/json or multipart/form-data. */
  requestContentType?: string;
  responseSchema?: Schema;
  /** Vendor extensions (x-*) declared on the operation. */
  extensions: Record<string, unknown>;
}

export interface ApiSpec {
  title: string;
  version: string;
  operations: Operation[];
  /** Parts of the document undogen could not fully understand. Never silently dropped. */
  warnings: string[];
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
  /**
   * - params / query / request / response / before: dotted path into that object
   * - location: the last path segment of the response's Location header (key is ignored)
   */
  from: 'params' | 'query' | 'response' | 'before' | 'request' | 'location';
  /** Dotted path into the source object, e.g. "id" or "data.id". */
  key: string;
}

export type BodyTemplate =
  /** Fields copied from the state captured before the original call. '*' = all fields. */
  | { from: 'before'; fields: string[] | '*' }
  /**
   * Copy from `before` exactly the keys that the original request body sent.
   * `nullMissing` (JSON Merge Patch): keys that did not exist before are sent as null, which removes them.
   */
  | { from: 'before-request-keys'; nullMissing?: boolean }
  /** The inverse of an RFC 6902 JSON Patch, computed from `before` for every member the patch touched. */
  | { from: 'before-json-patch' }
  /** The original request body; with `fields`, only those top-level fields (what the target accepts). */
  | { from: 'request'; fields?: string[] }
  /** A fixed body, e.g. { state: 'closed' } for soft deletes. */
  | { from: 'literal'; value: unknown }
  /** A body assembled field by field, e.g. Slack chat.delete { channel: response.channel, ts: response.ts }. */
  | { from: 'fields'; fields: Record<string, ValueRef> };

/**
 * How a spec author (x-undogen) or a third party (overrides file) declares
 * an operation's undo behaviour. Bindings use "source.key" strings, e.g.
 * { repo: 'response.name', owner: 'response.owner.login' }, or "location"
 * for the id at the end of the response's Location header.
 */
export interface Declaration {
  reversibility?: Reversibility;
  reason?: string;
  inverse?: string;
  bindings?: Record<string, string>;
  body?: 'before' | 'request' | 'before-request-keys' | 'before-json-patch' | { literal: unknown } | { fields: Record<string, string> };
  /** Inverse to use when the capture found nothing (e.g. a PUT that created the resource). */
  inverseIfMissing?: string;
  /** Recorded by `undogen annotate` so a round-trip keeps the original strategy name. */
  strategy?: Strategy;
  /** Recorded by `undogen annotate`: the compiler's confidence. Hand-written declarations default to 1. */
  confidence?: number;
  /** Free-form notes (ignored), e.g. hints written by `undogen init`. */
  [note: `_${string}`]: unknown;
}

export interface RequestTemplate {
  operationId: string;
  method: HttpMethod;
  path: string;
  bindings: Record<string, ValueRef>;
  /** Query parameters for the request, e.g. an api-version the original call also sent. */
  query?: Record<string, ValueRef>;
  body?: BodyTemplate;
}

/** How to re-create one child collection of a deleted resource (opt-in: `restoreChildren`). */
export interface ChildPlan {
  /** GET that lists the children before the parent is deleted. */
  list: RequestTemplate;
  /** POST that re-creates one child under the (re-created) parent. */
  create: RequestTemplate & { body: { from: 'before'; fields: string[] | '*' } };
  /** Path parameter that identifies one child, e.g. "commentId". */
  param: string;
  /** Field holding a child's id, both in list items and in the create response. */
  idKey: string;
  /** This child's own child collections (grandchildren), a few levels deep. */
  children?: ChildPlan[];
}

/** The compiled undo recipe for one mutating operation. */
export interface InversePlan {
  operationId: string;
  method: HttpMethod;
  path: string;
  reversibility: Reversibility;
  strategy: Strategy;
  /** 0..1: how sure the compiler is, before verification. Heuristic, not calibrated. */
  confidence: number;
  /** Request that captures state before the original call runs. */
  capture?: RequestTemplate;
  /** Request that undoes the original call. */
  inverse?: RequestTemplate;
  /** Alternate inverse when the capture found nothing (e.g. PUT that created a resource). */
  inverseIfMissing?: RequestTemplate;
  /**
   * GET that reads the state the original call produced. Before undoing, the
   * runtime re-reads it: if someone else changed what the agent wrote, the
   * undo stops with a ConflictError instead of overwriting their change.
   */
  check?: RequestTemplate;
  /**
   * How `check` is used. Default: compare the fields the call wrote. 'diff': read the
   * state before and after the call and expect the fields that changed to stay that way
   * (paired actions, toggles). 'diff-exact': the check reads the toggled resource itself,
   * so "nothing changed" means the call was a no-op and the undo does nothing.
   */
  checkMode?: 'diff' | 'diff-exact';
  /** For inverses that re-create a resource: which response field carries its new id. */
  identity?: { param: string; responseKey: string };
  /** Child collections to re-create after re-creating a deleted parent. */
  children?: ChildPlan[];
  /** For `unknown` plans: the inverse undogen suspects, so `undogen learn` can try to confirm it. */
  suggestion?: { inverse: string; param: string };
  reasons: string[];
  caveats: string[];
}

export interface Analysis {
  spec: { title: string; version: string };
  plans: InversePlan[];
  summary: Record<Reversibility, number> & { total: number; readOnly: number };
  warnings: string[];
}
