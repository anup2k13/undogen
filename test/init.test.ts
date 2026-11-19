import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze, generateFixtures, loadSpec, verify, type ApiSpec } from '../src/index.js';
import { startTodoServer } from '../examples/todo-api/server.js';
import handWritten from '../examples/todo-api/fixtures.json' with { type: 'json' };

let server: Awaited<ReturnType<typeof startTodoServer>>;
let spec: ApiSpec;

beforeAll(async () => {
  server = await startTodoServer();
  spec = await loadSpec(new URL('../examples/todo-api/openapi.yaml', import.meta.url).pathname);
});
afterAll(() => server.close());

describe('verify: inconclusive outcome', () => {
  it('flags an operation that changed nothing instead of blaming the API, and suggests a prepare step', async () => {
    const report = await verify({ spec, baseUrl: server.url, only: ['unarchiveTodo'] });
    const r = report.results[0]!;
    expect(r.outcome).toBe('inconclusive');
    expect(r.detail).toContain('"prepare": [{ "operationId": "archiveTodo" }]');
  });
});

describe('undogen init', () => {
  it('derives the hand-written demo fixtures from the spec alone', async () => {
    const { fixtures, report } = await generateFixtures({ spec });
    expect(report).toBeUndefined();
    expect(fixtures.unarchiveTodo!.prepare).toEqual(handWritten.unarchiveTodo.prepare);
    expect(fixtures.createTodo!.body).toEqual({ title: 'Write the README', done: false });
    expect(fixtures.createComment!.body).toEqual({ text: 'Looks good to me' });
    expect(fixtures).not.toHaveProperty('sendReminder');
  });

  it('produces fixtures that verify exactly like the hand-written ones', async () => {
    const { fixtures, report, todo } = await generateFixtures({ spec, baseUrl: server.url });
    expect(todo).toEqual([]);
    expect(report!.summary).toMatchObject({ verified: 6, failed: 2, inconclusive: 0, gated: 1, error: 0 });
    const again = await verify({ spec, baseUrl: server.url, fixtures });
    expect(again.summary).toMatchObject({ verified: 6, failed: 2, inconclusive: 0 });
  });

  it('discovers a missing prepare step by probing when the names give no clue', async () => {
    // A declared inverse hides the archive/unarchive naming from the static pass.
    const plans = analyze(spec, { overrides: { unarchiveTodo: { inverse: 'archiveTodo' } } }).plans;
    const progress: string[] = [];
    const { fixtures, report } = await generateFixtures({ spec, plans, baseUrl: server.url, onProgress: (m) => progress.push(m) });
    expect(fixtures.unarchiveTodo!.prepare).toEqual([{ operationId: 'archiveTodo' }]);
    expect(progress).toContain('unarchiveTodo: added prepare archiveTodo → verified');
    expect(report!.results.find((r) => r.operationId === 'unarchiveTodo')!.outcome).toBe('verified');
  });

  it('lists what still needs a human when the API rejects generated data', async () => {
    // Without an example or schema, the create body can't be synthesized and the API answers 400.
    const blind: ApiSpec = {
      ...spec,
      operations: spec.operations.map((o) => (o.id === 'createTodo' ? { ...o, requestSchema: undefined, requestExample: undefined } : o)),
    };
    const { todo, fixtures } = await generateFixtures({ spec: blind, baseUrl: server.url });
    const createTodo = todo.find((t) => t.operationId === 'createTodo');
    expect(createTodo?.reason).toContain('HTTP 400');
    expect(fixtures.createTodo!.note).toMatch(/^TODO: /);
  });
});
