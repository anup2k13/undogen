import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze, loadSpec, parseSpec, synthesize } from '../src/index.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'undogen-spec-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('Swagger 2.0', () => {
  const spec = parseSpec({
    swagger: '2.0',
    info: { title: 'Pets', version: '2' },
    consumes: ['application/json'],
    definitions: {
      Pet: { type: 'object', properties: { id: { type: 'integer', readOnly: true }, name: { type: 'string' } } },
    },
    paths: {
      '/pets': {
        post: {
          operationId: 'addPet',
          parameters: [{ in: 'body', name: 'body', schema: { $ref: '#/definitions/Pet' } }],
          responses: { '201': { description: '', schema: { $ref: '#/definitions/Pet' } } },
        },
      },
      '/pets/{petId}': {
        parameters: [{ in: 'path', name: 'petId', required: true, type: 'integer' }],
        get: { operationId: 'getPet', responses: { '200': { description: '', schema: { $ref: '#/definitions/Pet' } } } },
        delete: { operationId: 'deletePet', responses: { '204': { description: '' } } },
      },
      '/pets/{petId}/photo': {
        post: {
          operationId: 'uploadPhoto',
          consumes: ['multipart/form-data'],
          parameters: [{ in: 'formData', name: 'file', type: 'file', required: true }, { in: 'formData', name: 'caption', type: 'string' }],
          responses: { '200': { description: '' } },
        },
      },
    },
  });

  it('reads body parameters, response schemas and definitions', () => {
    const add = spec.operations.find((o) => o.id === 'addPet')!;
    expect(add.requestContentType).toBe('application/json');
    expect(add.requestSchema!.properties!.name).toEqual({ type: 'string' });
    const plan = analyze(spec).plans.find((p) => p.operationId === 'addPet')!;
    expect(plan).toMatchObject({ strategy: 'delete-created', inverse: { bindings: { petId: { from: 'response', key: 'id' } } } });
  });

  it('turns formData parameters into a form body', () => {
    const up = spec.operations.find((o) => o.id === 'uploadPhoto')!;
    expect(up.requestContentType).toBe('multipart/form-data');
    expect(up.requestSchema).toMatchObject({ properties: { caption: { type: 'string' } }, required: ['file'] });
  });
});

describe('OpenAPI parsing details', () => {
  it('merges path-level and operation-level parameters', () => {
    const spec = parseSpec({
      openapi: '3.1.0',
      info: { title: 'x', version: '1' },
      paths: {
        '/a': {
          parameters: [{ name: 'api-version', in: 'query', required: true }, { name: 'x-tenant', in: 'header' }],
          post: { parameters: [{ name: 'api-version', in: 'query', required: false }], responses: {} },
        },
      },
    });
    const op = spec.operations[0]!;
    expect(op.id).toBe('POST /a');
    expect(op.queryParams).toEqual([{ name: 'api-version', in: 'query', required: false, schema: undefined }]);
    expect(op.headerParams.map((h) => h.name)).toEqual(['x-tenant']);
  });

  it('unions oneOf variants for lookups but synthesizes a single variant', () => {
    const spec = parseSpec({
      openapi: '3.1.0',
      info: { title: 'x', version: '1' },
      paths: {
        '/shapes': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      { type: 'object', required: ['kind', 'radius'], properties: { kind: { const: 'circle', type: 'string', enum: ['circle'] }, radius: { type: 'number' } } },
                      { type: 'object', required: ['kind', 'side'], properties: { kind: { type: 'string', enum: ['square'] }, side: { type: 'number' } } },
                    ],
                  },
                },
              },
            },
            responses: {},
          },
        },
      },
    });
    const schema = spec.operations[0]!.requestSchema!;
    expect(Object.keys(schema.properties!)).toEqual(['kind', 'radius', 'side']);
    expect(schema.required).toEqual(['kind']);
    expect(synthesize(schema)).toEqual({ kind: 'circle', radius: 1 });
  });

  it('handles 3.1 nullable type arrays and examples arrays', () => {
    expect(synthesize({ type: 'object', properties: { a: { type: ['null', 'string'] }, b: { type: 'integer', examples: [42] } } })).toEqual({
      a: 'undogen-a',
      b: 42,
    });
  });

  it('truncates circular $refs with a warning instead of failing', () => {
    const spec = parseSpec({
      openapi: '3.0.3',
      info: { title: 'x', version: '1' },
      components: { schemas: { Node: { type: 'object', properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } } } } } },
      paths: { '/nodes': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } }, responses: {} } } },
    });
    expect(spec.operations[0]!.requestSchema!.properties!.name).toEqual({ type: 'string' });
    expect(spec.warnings).toEqual(['1 recursive schema(s) truncated where they recurse (Node); harmless for analysis']);
  });

  it('keeps deeply nested schemas that the old depth limit silently dropped', () => {
    let schema: any = { type: 'object', properties: { leaf: { type: 'string' } } };
    for (let i = 0; i < 30; i++) schema = { type: 'object', properties: { [`l${i}`]: schema } };
    const spec = parseSpec({ openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: { '/d': { post: { requestBody: { content: { 'application/json': { schema } } }, responses: {} } } } });
    let node: any = spec.operations[0]!.requestSchema;
    for (let i = 29; i >= 0; i--) node = node.properties[`l${i}`];
    expect(node.properties.leaf).toEqual({ type: 'string' });
    expect(spec.warnings).toEqual([]);
  });

  it('warns about external $refs it cannot load', () => {
    const spec = parseSpec({
      openapi: '3.0.3',
      info: { title: 'x', version: '1' },
      paths: { '/a': { post: { requestBody: { content: { 'application/json': { schema: { $ref: 'schemas.yaml#/A' } } } }, responses: {} } } },
    });
    expect(spec.warnings[0]).toMatch(/External \$ref schemas.yaml#\/A could not be resolved/);
  });
});

describe('external $refs', () => {
  it('loads referenced files relative to the spec, including their own local refs', async () => {
    await writeFile(
      join(dir, 'openapi.yaml'),
      [
        'openapi: 3.0.3',
        'info: { title: Split, version: "1" }',
        'paths:',
        '  /things:',
        '    $ref: "./paths/things.yaml"',
      ].join('\n'),
    );
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'paths'), { recursive: true });
    await writeFile(
      join(dir, 'paths', 'things.yaml'),
      [
        'post:',
        '  operationId: createThing',
        '  requestBody: { content: { application/json: { schema: { $ref: "../schemas.yaml#/Thing" } } } }',
        '  responses: { "201": { description: "", content: { application/json: { schema: { $ref: "../schemas.yaml#/Thing" } } } } }',
      ].join('\n'),
    );
    await writeFile(
      join(dir, 'schemas.yaml'),
      ['Thing:', '  type: object', '  properties:', '    id: { $ref: "#/Id" }', '    name: { type: string }', 'Id: { type: string, readOnly: true }'].join('\n'),
    );
    const spec = await loadSpec(join(dir, 'openapi.yaml'));
    expect(spec.warnings).toEqual([]);
    expect(spec.operations[0]!.requestSchema!.properties).toEqual({ id: { type: 'string', readOnly: true }, name: { type: 'string' } });
  });
});
