import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { generateTypes, loadSpec, schemaToTs } from '../src/index.js';

const root = new URL('..', import.meta.url).pathname;
const dir = join(root, 'test/.generated');
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('schemaToTs', () => {
  it('covers the JSON Schema subset OpenAPI uses', () => {
    expect(schemaToTs({ type: 'object', required: ['id'], properties: { id: { type: 'string' }, 'x-y': { type: 'integer', nullable: true } } })).toBe('{ id: string; "x-y"?: number | null }');
    expect(schemaToTs({ type: 'array', items: { enum: ['a', 'b'] } })).toBe('Array<"a" | "b">');
    expect(schemaToTs({ type: 'object', additionalProperties: { type: 'boolean' } })).toBe('{ [key: string]: boolean }');
    expect(schemaToTs({ oneOf: [{ type: 'string' }, { type: 'number' }] })).toBe('string | number');
    expect(schemaToTs(undefined)).toBe('unknown');
  });
});

describe('undogen types', () => {
  it('generates interfaces that make calls type-checked', async () => {
    const spec = await loadSpec(join(root, 'examples/todo-api/openapi.yaml'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'api-types.ts'), generateTypes(spec));
    await writeFile(
      join(dir, 'use.ts'),
      [
        "import { typed, UndoableClient, loadSpec } from '../../src/index.js';",
        "import type { Operations } from './api-types.js';",
        "const api = typed<Operations>(new UndoableClient({ spec: await loadSpec('x'), baseUrl: 'http://x' }));",
        "const created = await api.call('createTodo', { body: { title: 'ok', done: false } });",
        'const title: string | undefined = created.data.title; // the spec does not mark title as required',
        "await api.call('updateTodo', { params: { todoId: 't1' }, body: { done: true } });",
        "await api.call('listTodos', {});",
        '// @ts-expect-error unknown operation',
        "await api.call('createTodos', { body: { title: 'x' } });",
        '// @ts-expect-error title is required',
        "await api.call('createTodo', { body: { done: true } });",
        '// @ts-expect-error params are required',
        "await api.call('getTodo', {});",
        '// @ts-expect-error done is a boolean',
        "await api.call('updateTodo', { params: { todoId: 't1' }, body: { done: 'yes' } });",
        'void title;',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', strict: true, noEmit: true, skipLibCheck: true, types: ['node'] }, files: ['use.ts'] }),
    );
    const { stdout } = await promisify(execFile)(join(root, 'node_modules/.bin/tsc'), ['-p', dir]).catch((e) => e);
    expect(stdout ?? '').toBe('');
  }, 60_000);
});
