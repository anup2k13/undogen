import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { ApiSpec, HttpMethod, Operation, Parameter, Schema } from './types.js';

const METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];
const MAX_COMPOSITE_DEPTH = 6;

export interface ParseOptions {
  /** URI of the document being parsed, used to resolve relative external $refs. */
  baseUri?: string;
  /** Already-loaded documents referenced by external $refs, keyed by absolute URI (no fragment). */
  documents?: Map<string, unknown>;
  /** External $refs that were not loaded, with the reason (reported as warnings). */
  refused?: Map<string, string>;
}

export interface LoadOptions {
  fetch?: typeof fetch;
  /**
   * Follow external $refs anywhere. By default a spec loaded from a URL may only reference
   * documents on its own origin: never local files (file:) or other hosts such as cloud
   * metadata endpoints, since their contents can end up in request bodies verify sends.
   * A spec loaded from a local file may reference other files and URLs.
   */
  trustRefs?: boolean;
}

/**
 * Load an OpenAPI 3.x or Swagger 2.0 document (JSON or YAML) from a file path
 * or http(s) URL. External $refs (other files or URLs) are loaded too.
 */
export async function loadSpec(source: string, options: LoadOptions = {}): Promise<ApiSpec> {
  const baseUri = /^https?:\/\//i.test(source) ? source : pathToFileURL(resolvePath(source)).href;
  const documents = new Map<string, unknown>();
  const refused = new Map<string, string>();
  const root = await fetchDocument(baseUri, options);
  documents.set(stripHash(baseUri), root);
  await loadExternalRefs(root, baseUri, documents, options, refused);
  return parseSpec(root as object, { baseUri, documents, refused });
}

/** Why a document referenced from a spec rooted at `rootUri` may not be loaded, or undefined if it may. */
export function refusedRef(uri: string, rootUri: string, trust = false): string | undefined {
  if (trust) return undefined;
  const target = new URL(uri);
  const root = new URL(rootUri);
  if (!['file:', 'http:', 'https:'].includes(target.protocol)) return `scheme ${target.protocol} is not supported`;
  if (root.protocol === 'file:') return undefined; // a local spec is the user's own: its refs are trusted
  if (target.protocol === 'file:') return 'a spec loaded from a URL may not read local files';
  if (target.origin !== root.origin) return `a spec from ${root.origin} may only reference documents on the same origin (use --trust-refs to allow ${target.origin})`;
  return undefined;
}

/** A referenced document that may not be loaded (e.g. its URL redirects to another origin). */
class RefusedRef extends Error {}

/**
 * `rootUri` is set when loading a document referenced by the spec: redirects are then
 * checked against the same origin rule as the $ref itself, so a same-origin URL can't
 * redirect to a metadata endpoint.
 */
async function fetchDocument(uri: string, options: LoadOptions, rootUri?: string): Promise<unknown> {
  let text: string;
  if (uri.startsWith('file:')) {
    text = await readFile(fileURLToPath(uri), 'utf8');
  } else {
    text = await fetchText(uri, options, rootUri && !options.trustRefs ? rootUri : undefined);
  }
  return parseText(text);
}

/** JSON is valid YAML, but JSON.parse is an order of magnitude faster on large specs. */
function parseText(text: string): unknown {
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      /* not strict JSON (comments, trailing commas): fall back to the YAML parser */
    }
  }
  return parseYaml(text, { maxAliasCount: -1 });
}

/** GET a document, retrying transient failures (multi-file specs mean many requests). */
async function fetchText(uri: string, options: LoadOptions, checkRedirectsAgainst?: string, attempts = 4): Promise<string> {
  let url = uri;
  for (let i = 0, hops = 0; ; i++) {
    let permanent: Error | undefined;
    try {
      const res = await (options.fetch ?? fetch)(url, checkRedirectsAgainst ? { redirect: 'manual' } : undefined);
      if (checkRedirectsAgainst && (res.type === 'opaqueredirect' || res.status === 0)) {
        // Browsers and some fetch implementations hide manual redirects' targets.
        throw new RefusedRef('it redirects, and this fetch implementation does not say where to (use --trust-refs, or Node.js)');
      }
      if (checkRedirectsAgainst && res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location')!, url).href;
        const reason = refusedRef(next, checkRedirectsAgainst, options.trustRefs);
        if (reason) throw new RefusedRef(`it redirects to ${next}: ${reason}`);
        if (++hops > 5) throw new RefusedRef('too many redirects');
        url = next;
        i--;
        continue;
      }
      if (res.ok) return await res.text();
      if (i + 1 >= attempts || (res.status !== 429 && res.status < 500)) permanent = new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (err instanceof RefusedRef) throw err;
      if (i + 1 >= attempts) {
        const e = err as Error & { cause?: { code?: string; message?: string } };
        const cause = e.cause?.code ?? e.cause?.message;
        throw new Error(`Could not fetch ${uri}: ${e.message}${cause ? ` (${cause})` : ''}`);
      }
    }
    if (permanent) throw new Error(`Could not fetch ${uri}: ${permanent.message}`);
    await new Promise((r) => setTimeout(r, 250 * 2 ** i));
  }
}

/** Load every document reachable through external $refs, with one global limit on concurrent fetches. */
async function loadExternalRefs(
  root: unknown,
  rootUri: string,
  documents: Map<string, unknown>,
  options: LoadOptions,
  refused: Map<string, string>,
): Promise<void> {
  const LIMIT = 8;
  const queue: string[] = [];
  const discover = (node: unknown, base: string) => {
    const walk = (n: unknown) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      for (const [k, v] of Object.entries(n)) {
        if (k === '$ref' && typeof v === 'string' && !v.startsWith('#')) {
          const uri = stripHash(new URL(v, base).href);
          if (!documents.has(uri)) {
            documents.set(uri, null); // reserve, so each file is fetched once
            const reason = refusedRef(uri, rootUri, options.trustRefs);
            if (reason) refused.set(uri, reason);
            else queue.push(uri);
          }
        } else walk(v);
      }
    };
    walk(node);
  };
  discover(root, rootUri);
  let active = 0;
  await new Promise<void>((resolve, reject) => {
    let failed = false;
    const pump = () => {
      if (failed) return;
      if (!queue.length && !active) return resolve();
      while (active < LIMIT && queue.length) {
        const uri = queue.shift()!;
        active++;
        fetchDocument(uri, options, rootUri).then(
          (doc) => {
            documents.set(uri, doc);
            discover(doc, uri);
            active--;
            pump();
          },
          (err) => {
            if (err instanceof RefusedRef) {
              refused.set(uri, err.message); // reported as a warning, like any refused $ref
              active--;
              return pump();
            }
            failed = true;
            reject(err);
          },
        );
      }
    };
    pump();
  });
}

const stripHash = (uri: string) => uri.split('#')[0]!;

/** The component name each resolved $ref came from (e.g. "simple-user"), for naming generated types. */
export const refNames = new WeakMap<object, string>();

/** Parse an OpenAPI 3.x / Swagger 2.0 document from text (JSON or YAML) or an already-parsed object. */
export function parseSpec(input: string | object, options: ParseOptions = {}): ApiSpec {
  const doc = (typeof input === 'string' ? parseText(input) : input) as Record<string, any>;
  if (!doc || typeof doc !== 'object' || typeof doc.paths !== 'object') {
    throw new Error('Not an OpenAPI document: missing "paths"');
  }
  const isSwagger2 = typeof doc.swagger === 'string' && doc.swagger.startsWith('2');
  const baseUri = options.baseUri ?? 'undogen:root';
  const documents = options.documents ?? new Map<string, unknown>();
  if (!documents.has(stripHash(baseUri))) documents.set(stripHash(baseUri), doc);

  const warnings = new Set<string>();
  const recursive = new Set<string>();
  const memo = new Map<string, unknown>();
  const stack = new Set<string>();

  const resolvePointer = (target: unknown, fragment: string, ref: string): unknown => {
    let node: any = target;
    if (!fragment || fragment === '/') return node;
    for (const raw of fragment.replace(/^\//, '').split('/')) {
      const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
      node = node?.[key];
      if (node === undefined) throw new Error(`Unresolvable $ref: ${ref}`);
    }
    return node;
  };

  const deref = (node: unknown, base: string): any => {
    if (Array.isArray(node)) return node.map((n) => deref(n, base));
    if (!node || typeof node !== 'object') return node;
    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === 'string') {
      const ref = obj.$ref;
      const [uriPart, fragment = ''] = ref.split('#') as [string, string?];
      const docUri = uriPart ? stripHash(new URL(uriPart, base.startsWith('undogen:') ? 'file:///' : base).href) : stripHash(base);
      const key = `${docUri}#${fragment}`;
      if (memo.has(key)) return memo.get(key);
      if (stack.has(key)) {
        recursive.add(ref);
        return {};
      }
      const target = documents.get(docUri);
      if (target == null) {
        const reason = options.refused?.get(docUri);
        warnings.add(reason ? `External $ref ${ref} was not loaded: ${reason}` : `External $ref ${ref} could not be resolved (use loadSpec with a file path or URL)`);
        return {};
      }
      stack.add(key);
      const resolved = deref(resolvePointer(target, fragment, ref), docUri);
      stack.delete(key);
      memo.set(key, resolved);
      const name = fragment.split('/').filter(Boolean).at(-1);
      if (name && resolved && typeof resolved === 'object' && !refNames.has(resolved)) refNames.set(resolved, decodeURIComponent(name));
      return resolved;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = deref(v, base);
    return out;
  };

  const operations: Operation[] = [];
  for (const [path, rawItem] of Object.entries<any>(doc.paths)) {
    const item = deref(rawItem, baseUri);
    for (const method of METHODS) {
      const op = item?.[method];
      if (!op) continue;
      const id = op.operationId ?? `${method.toUpperCase()} ${path}`;
      const params = mergeParams(item.parameters, op.parameters);
      const extensions: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(op)) if (k.startsWith('x-')) extensions[k] = v;

      let requestSchema: Schema | undefined;
      let requestExample: unknown;
      let requestContentType: string | undefined;
      let responseSchema: Schema | undefined;
      if (isSwagger2) {
        const consumes: string[] = op.consumes ?? doc.consumes ?? ['application/json'];
        const bodyParam = params.find((p) => p.in === 'body');
        const formParams = params.filter((p) => p.in === 'formData');
        if (bodyParam) {
          requestSchema = bodyParam.schema;
          requestContentType = consumes.find((c) => /json/i.test(c)) ?? consumes[0];
        } else if (formParams.length) {
          requestSchema = {
            type: 'object',
            properties: Object.fromEntries(formParams.map((p) => [p.name, p.schema ?? { type: p.type, format: p.format, enum: p.enum }])),
            required: formParams.filter((p) => p.required).map((p) => p.name),
          };
          const multipart = formParams.some((p) => p.type === 'file') || consumes.some((c) => /multipart/i.test(c));
          requestContentType = multipart ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
        }
        const ok = Object.keys(op.responses ?? {}).filter((c) => /^2/.test(c)).sort();
        for (const code of ok) {
          const r = op.responses[code];
          if (r?.schema) {
            responseSchema = r.schema;
            break;
          }
        }
      } else {
        const content = pickContent(op.requestBody?.content);
        if (content) {
          requestContentType = content.type;
          requestSchema = content.media?.schema;
          requestExample = content.media?.example ?? firstExample(content.media?.examples);
          if (!isSupportedMediaType(content.type)) {
            warnings.add(`${id}: request media type ${content.type} is not supported; bodies will be sent as JSON`);
          }
        }
        responseSchema = successResponseContent(op.responses)?.schema;
      }

      operations.push({
        id,
        method,
        path,
        summary: op.summary,
        description: op.description,
        tags: Array.isArray(op.tags) ? op.tags.filter((t: unknown): t is string => typeof t === 'string') : [],
        ...(op.deprecated === true ? { deprecated: true } : {}),
        pathParams: pathParamsOf(path),
        queryParams: toParameters(params, 'query'),
        headerParams: toParameters(params, 'header'),
        requestSchema: normalizeSchema(requestSchema),
        requestExample,
        requestContentType,
        responseSchema: normalizeSchema(responseSchema),
        extensions,
      });
    }
  }

  if (recursive.size) {
    const names = [...recursive].map((r) => r.split('/').at(-1)).slice(0, 3).join(', ');
    warnings.add(
      `${recursive.size} recursive schema(s) truncated where they recurse (${names}${recursive.size > 3 ? ', …' : ''}); harmless for analysis`,
    );
  }
  return {
    title: doc.info?.title ?? 'Untitled API',
    version: String(doc.info?.version ?? '0.0.0'),
    operations,
    warnings: [...warnings],
  };
}

/**
 * A path without format suffixes, for structural matching: Twilio-style
 * /Accounts/{Sid}/Calls.json and /Accounts/{Sid}/Calls/{CallSid}.json become
 * /Accounts/{Sid}/Calls and /Accounts/{Sid}/Calls/{CallSid}.
 */
export function structuralPath(path: string): string {
  return path.replace(/\.(json|xml)(?=\/|$)/gi, '');
}

export function pathParamsOf(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

/** Operation-level parameters override path-level ones with the same name and location. */
function mergeParams(pathLevel: any[] | undefined, opLevel: any[] | undefined): any[] {
  const out = new Map<string, any>();
  for (const p of [...(pathLevel ?? []), ...(opLevel ?? [])]) {
    if (p && typeof p === 'object' && typeof p.name === 'string') out.set(`${p.in}:${p.name}`, p);
  }
  return [...out.values()];
}

/** Header parameters OpenAPI says to ignore (they're set by the client or by security schemes), plus cookies. */
const RESERVED_HEADERS = new Set(['accept', 'content-type', 'authorization', 'cookie']);

function toParameters(params: any[], where: 'query' | 'header'): Parameter[] {
  return params
    .filter((p) => p.in === where && !(where === 'header' && RESERVED_HEADERS.has(String(p.name).toLowerCase())))
    .map((p) => ({ name: p.name, in: where, required: !!p.required, schema: p.schema ?? (p.type ? { type: p.type, enum: p.enum, default: p.default } : undefined) }));
}

const isJson = (type: string) => /json/i.test(type);
const isSupportedMediaType = (type: string) =>
  isJson(type) || /x-www-form-urlencoded|multipart\/form-data|^text\/plain/i.test(type);

/** Prefer JSON, then forms, then whatever comes first. */
function pickContent(content: Record<string, any> | undefined): { type: string; media: any } | undefined {
  if (!content) return undefined;
  const keys = Object.keys(content);
  const key = keys.find(isJson) ?? keys.find((k) => /x-www-form-urlencoded|multipart/i.test(k)) ?? keys[0];
  return key ? { type: key, media: content[key] } : undefined;
}

function successResponseContent(responses: Record<string, any> | undefined): any {
  if (!responses) return undefined;
  const codes = Object.keys(responses).filter((c) => /^2/.test(c)).sort();
  for (const code of codes) {
    const c = pickContent(responses[code]?.content);
    if (c) return c.media;
  }
  return undefined;
}

function firstExample(examples: Record<string, any> | undefined): unknown {
  if (!examples) return undefined;
  const first = Object.values(examples)[0];
  return first?.value;
}

/**
 * Flatten composite schemas so property lookups work:
 * - allOf: merge every part's properties and required lists
 * - oneOf / anyOf: union of the variants' properties (required = only what every variant requires);
 *   the variants are kept, so synthesis can pick one valid variant instead of mixing them
 * Nested object properties are flattened too, a few levels deep.
 */
export function normalizeSchema(schema: Schema | undefined, depth = 0): Schema | undefined {
  if (!schema || typeof schema !== 'object' || depth > MAX_COMPOSITE_DEPTH) return schema;
  // $refs resolve to shared objects, so the same schema is normalized for many operations: memoize.
  let byDepth = normalized.get(schema);
  if (!byDepth) normalized.set(schema, (byDepth = new Map()));
  const cached = byDepth.get(depth);
  if (cached) return cached;
  const result = normalizeUncached(schema, depth);
  const name = refNames.get(schema);
  if (name && !refNames.has(result)) refNames.set(result, name);
  byDepth.set(depth, result);
  return result;
}

const normalized = new WeakMap<object, Map<number, Schema>>();

function normalizeUncached(schema: Schema, depth: number): Schema {
  let out: Schema = schema;
  if (Array.isArray(schema.allOf)) {
    const merged: Schema = { ...schema, type: 'object', properties: { ...(schema.properties ?? {}) }, required: [...(schema.required ?? [])] };
    delete merged.allOf;
    for (const part of schema.allOf as Schema[]) {
      const p = normalizeSchema(part, depth + 1);
      Object.assign(merged.properties!, p?.properties ?? {});
      merged.required!.push(...(p?.required ?? []));
      if (p?.example !== undefined && merged.example === undefined) merged.example = p.example;
    }
    out = merged;
  }
  const variants = (Array.isArray(out.oneOf) ? out.oneOf : Array.isArray(out.anyOf) ? out.anyOf : undefined) as Schema[] | undefined;
  if (variants?.length && !out.properties) {
    const normalized = variants.map((v) => normalizeSchema(v, depth + 1) ?? {});
    const objects = normalized.filter((v) => v.properties);
    if (objects.length) {
      const props: Record<string, Schema> = {};
      for (const v of objects) Object.assign(props, v.properties);
      const required = (objects[0]!.required ?? []).filter((r) => objects.every((v) => v.required?.includes(r)));
      out = { ...out, type: out.type ?? 'object', properties: props, required, 'x-undogen-variants': normalized };
    }
  }
  if (out.properties) {
    const props: Record<string, Schema> = {};
    for (const [k, v] of Object.entries(out.properties)) props[k] = normalizeSchema(v, depth + 1) ?? v;
    out = { ...out, properties: props };
  }
  if (out.items) out = { ...out, items: normalizeSchema(out.items, depth + 1) };
  return out;
}
