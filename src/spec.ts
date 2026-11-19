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
}

export interface LoadOptions {
  fetch?: typeof fetch;
}

/**
 * Load an OpenAPI 3.x or Swagger 2.0 document (JSON or YAML) from a file path
 * or http(s) URL. External $refs (other files or URLs) are loaded too.
 */
export async function loadSpec(source: string, options: LoadOptions = {}): Promise<ApiSpec> {
  const baseUri = /^https?:\/\//i.test(source) ? source : pathToFileURL(resolvePath(source)).href;
  const documents = new Map<string, unknown>();
  const root = await fetchDocument(baseUri, options);
  documents.set(stripHash(baseUri), root);
  await loadExternalRefs(root, baseUri, documents, options);
  return parseSpec(root as object, { baseUri, documents });
}

async function fetchDocument(uri: string, options: LoadOptions): Promise<unknown> {
  let text: string;
  if (uri.startsWith('file:')) {
    text = await readFile(fileURLToPath(uri), 'utf8');
  } else {
    const res = await (options.fetch ?? fetch)(uri);
    if (!res.ok) throw new Error(`Could not fetch ${uri}: HTTP ${res.status}`);
    text = await res.text();
  }
  return parseYaml(text, { maxAliasCount: -1 });
}

async function loadExternalRefs(node: unknown, base: string, documents: Map<string, unknown>, options: LoadOptions): Promise<void> {
  const pending: Array<{ uri: string }> = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n)) {
      if (k === '$ref' && typeof v === 'string' && !v.startsWith('#')) {
        const uri = stripHash(new URL(v, base).href);
        if (!documents.has(uri)) {
          documents.set(uri, null); // reserve, so cycles between files terminate
          pending.push({ uri });
        }
      } else walk(v);
    }
  };
  walk(node);
  for (const { uri } of pending) {
    const doc = await fetchDocument(uri, options);
    documents.set(uri, doc);
    await loadExternalRefs(doc, uri, documents, options);
  }
}

const stripHash = (uri: string) => uri.split('#')[0]!;

/** Parse an OpenAPI 3.x / Swagger 2.0 document from text (JSON or YAML) or an already-parsed object. */
export function parseSpec(input: string | object, options: ParseOptions = {}): ApiSpec {
  const doc = (typeof input === 'string' ? parseYaml(input, { maxAliasCount: -1 }) : input) as Record<string, any>;
  if (!doc || typeof doc !== 'object' || typeof doc.paths !== 'object') {
    throw new Error('Not an OpenAPI document: missing "paths"');
  }
  const isSwagger2 = typeof doc.swagger === 'string' && doc.swagger.startsWith('2');
  const baseUri = options.baseUri ?? 'undogen:root';
  const documents = options.documents ?? new Map<string, unknown>();
  if (!documents.has(stripHash(baseUri))) documents.set(stripHash(baseUri), doc);

  const warnings = new Set<string>();
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
        warnings.add(`Circular $ref ${ref} was truncated where it recurses`);
        return {};
      }
      const target = documents.get(docUri);
      if (target == null) {
        warnings.add(`External $ref ${ref} could not be resolved (use loadSpec with a file path or URL)`);
        return {};
      }
      stack.add(key);
      const resolved = deref(resolvePointer(target, fragment, ref), docUri);
      stack.delete(key);
      memo.set(key, resolved);
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

  return {
    title: doc.info?.title ?? 'Untitled API',
    version: String(doc.info?.version ?? '0.0.0'),
    operations,
    warnings: [...warnings],
  };
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

function toParameters(params: any[], where: 'query' | 'header'): Parameter[] {
  return params
    .filter((p) => p.in === where)
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
