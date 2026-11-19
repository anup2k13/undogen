import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { ApiSpec, HttpMethod, Operation, Schema } from './types.js';

const METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];
const MAX_REF_DEPTH = 24;

/** Load an OpenAPI 3.x document (JSON or YAML) from a file path or http(s) URL. */
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

/** Parse an OpenAPI 3.x document from text (JSON or YAML) or an already-parsed object. */
export function parseSpec(input: string | object): ApiSpec {
  const doc = (typeof input === 'string' ? parseYaml(input) : input) as Record<string, any>;
  if (!doc || typeof doc !== 'object' || typeof doc.paths !== 'object') {
    throw new Error('Not an OpenAPI document: missing "paths"');
  }

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
      const requestContent = jsonContent(op.requestBody?.content);
      const responseContent = successResponseContent(op.responses);
      const extensions: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(op)) if (k.startsWith('x-')) extensions[k] = v;

      operations.push({
        id: op.operationId ?? `${method.toUpperCase()} ${path}`,
        method,
        path,
        summary: op.summary,
        pathParams: pathParamsOf(path),
        requestSchema: mergeAllOf(requestContent?.schema),
        requestExample: requestContent?.example ?? firstExample(requestContent?.examples),
        requestRequired: op.requestBody?.required === true,
        responseSchema: mergeAllOf(responseContent?.schema),
        extensions,
      });
    }
  }

  return {
    title: doc.info?.title ?? 'Untitled API',
    version: String(doc.info?.version ?? '0.0.0'),
    operations,
  };
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
