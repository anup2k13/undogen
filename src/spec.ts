import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { ApiSpec, HttpMethod, Operation, Schema } from './types.js';

const METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];
const MAX_REF_DEPTH = 24;

/** Load an OpenAPI 3.x or Swagger 2.0 document (JSON or YAML) from a file path or http(s) URL. */
export async function loadSpec(source: string): Promise<ApiSpec> {
  let text: string;
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Could not fetch ${source}: HTTP ${res.status}`);
    text = await res.text();
  } else {
    text = await readFile(source, 'utf8');
  }
  return parseSpec(text);
}

/** Parse an OpenAPI 3.x or Swagger 2.0 document from text (JSON or YAML) or an already-parsed object. */
export function parseSpec(input: string | object): ApiSpec {
  const doc = (typeof input === 'string' ? parseYaml(input) : input) as Record<string, any>;
  if (!doc || typeof doc !== 'object' || typeof doc.paths !== 'object') {
    throw new Error('Not an OpenAPI or Swagger document: missing "paths"');
  }
  const swagger2 = String(doc.swagger ?? '').startsWith('2');

  const resolvePointer = (ref: string): unknown => {
    if (!ref.startsWith('#/')) return {}; // external refs are out of scope for v0.1
    let node: any = doc;
    for (const raw of ref.slice(2).split('/')) {
      const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      node = node?.[key];
      if (node === undefined) throw new Error(`Unresolvable $ref: ${ref}`);
    }
    return node;
  };

  const deref = (node: unknown, depth = 0): any => {
    if (depth > MAX_REF_DEPTH) return {};
    if (Array.isArray(node)) return node.map((n) => deref(n, depth + 1));
    if (!node || typeof node !== 'object') return node;
    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === 'string') return deref(resolvePointer(obj.$ref), depth + 1);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = deref(v, depth + 1);
    return out;
  };

  const operations: Operation[] = [];
  for (const [path, rawItem] of Object.entries<any>(doc.paths)) {
    const item = deref(rawItem);
    for (const method of METHODS) {
      const op = item?.[method];
      if (!op) continue;
      const extensions: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(op)) if (k.startsWith('x-')) extensions[k] = v;
      const request = swagger2 ? swagger2Request(item, op) : openapi3Request(op);

      operations.push({
        id: op.operationId ?? `${method.toUpperCase()} ${path}`,
        method,
        path,
        summary: op.summary,
        pathParams: pathParamsOf(path),
        ...request,
        requestSchema: mergeAllOf(request.requestSchema),
        responseSchema: mergeAllOf(swagger2 ? swagger2Response(op.responses) : successResponseContent(op.responses)?.schema),
        extensions,
      });
    }
  }

  return {
    title: doc.info?.title ?? 'Untitled API',
    version: String(doc.info?.version ?? '0.0.0'),
    basePath: swagger2 ? normalizeBasePath(doc.basePath) : serverPath(doc.servers),
    operations,
  };
}

type RequestInfo = Pick<Operation, 'requestSchema' | 'requestExample' | 'requestRequired' | 'requestFormat'>;

function openapi3Request(op: any): RequestInfo {
  const content = op.requestBody?.content as Record<string, any> | undefined;
  const json = jsonContent(content);
  const isForm = !!content && !Object.keys(content).some((k) => /json/i.test(k)) && Object.keys(content).some((k) => /form-urlencoded/i.test(k));
  return {
    requestSchema: json?.schema,
    requestExample: json?.example ?? firstExample(json?.examples),
    requestRequired: op.requestBody?.required === true,
    ...(isForm ? { requestFormat: 'form' as const } : {}),
  };
}

/** Swagger 2.0: the body is a single `in: body` parameter, or a set of `in: formData` parameters. */
function swagger2Request(item: any, op: any): RequestInfo {
  // Operation-level parameters override path-level ones with the same name and location.
  const params = new Map<string, any>();
  for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])]) params.set(`${p.in}:${p.name}`, p);
  const all = [...params.values()];
  const body = all.find((p) => p.in === 'body');
  if (body) {
    return {
      requestSchema: body.schema,
      requestExample: body.schema?.example ?? body['x-example'],
      requestRequired: body.required === true,
    };
  }
  const form = all.filter((p) => p.in === 'formData');
  if (!form.length) return {};
  const properties: Record<string, Schema> = {};
  for (const p of form) {
    properties[p.name] = {
      type: p.type === 'file' ? 'string' : p.type,
      ...(p.format ? { format: p.format } : {}),
      ...(p.enum ? { enum: p.enum } : {}),
      ...(p.default !== undefined ? { default: p.default } : {}),
      ...(p['x-example'] !== undefined ? { example: p['x-example'] } : {}),
      ...(p.items ? { items: p.items } : {}),
    };
  }
  return {
    requestSchema: { type: 'object', properties, required: form.filter((p) => p.required).map((p) => p.name) },
    requestRequired: form.some((p) => p.required),
    requestFormat: 'form',
  };
}

function swagger2Response(responses: Record<string, any> | undefined): Schema | undefined {
  if (!responses) return undefined;
  for (const code of Object.keys(responses).filter((c) => /^2/.test(c)).sort()) {
    if (responses[code]?.schema) return responses[code].schema;
  }
  return undefined;
}

function normalizeBasePath(p: unknown): string | undefined {
  if (typeof p !== 'string') return undefined;
  const trimmed = p.replace(/\/+$/, '');
  return trimmed && trimmed !== '/' ? (trimmed.startsWith('/') ? trimmed : `/${trimmed}`) : undefined;
}

/** The path part of OpenAPI 3 servers[0].url, e.g. "/v1" for "https://api.example.com/v1". */
function serverPath(servers: Array<{ url?: string }> | undefined): string | undefined {
  const url = servers?.[0]?.url;
  if (!url || url.includes('{')) return undefined; // server variables: let the user pass the full base URL
  try {
    return normalizeBasePath(new URL(url, 'http://placeholder').pathname);
  } catch {
    return undefined;
  }
}

export function pathParamsOf(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

function jsonContent(content: Record<string, any> | undefined): any {
  if (!content) return undefined;
  const key = Object.keys(content).find((k) => /json/i.test(k)) ?? Object.keys(content)[0];
  return key ? content[key] : undefined;
}

function successResponseContent(responses: Record<string, any> | undefined): any {
  if (!responses) return undefined;
  const codes = Object.keys(responses).filter((c) => /^2/.test(c)).sort();
  for (const code of codes) {
    const c = jsonContent(responses[code]?.content);
    if (c) return c;
  }
  return undefined;
}

function firstExample(examples: Record<string, any> | undefined): unknown {
  if (!examples) return undefined;
  const first = Object.values(examples)[0];
  return first?.value;
}

/** Flatten `allOf` object schemas so property lookups work. */
function mergeAllOf(schema: Schema | undefined): Schema | undefined {
  if (!schema || !Array.isArray(schema.allOf)) return schema;
  const merged: Schema = { type: 'object', properties: {}, required: [] };
  for (const part of schema.allOf as Schema[]) {
    const p = mergeAllOf(part);
    Object.assign(merged.properties!, p?.properties ?? {});
    merged.required!.push(...(p?.required ?? []));
  }
  return merged;
}
