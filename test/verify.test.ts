import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSpec, toBadge, toMarkdown, verify, type VerifyReport } from '../src/index.js';
import { startTodoServer } from '../examples/todo-api/server.js';
import fixtures from '../examples/todo-api/fixtures.json' with { type: 'json' };

let server: Awaited<ReturnType<typeof startTodoServer>>;
let report: VerifyReport;

beforeAll(async () => {
  server = await startTodoServer();
  const spec = await loadSpec(new URL('../examples/todo-api/openapi.yaml', import.meta.url).pathname);
  report = await verify({ spec, baseUrl: server.url, fixtures });
});
afterAll(() => server.close());

const result = (id: string) => report.results.find((r) => r.operationId === id)!;

describe('verify against the demo Todo API', () => {
  it('verifies the inverses that really work', () => {
    for (const id of ['createTodo', 'replaceTodo', 'updateTodo', 'createComment', 'deleteComment', 'unarchiveTodo']) {
      expect(result(id).outcome, `${id}: ${result(id).detail}`).toBe('verified');
    }
  });

  it('catches the cascading delete: re-creating a todo does not bring its comments back', () => {
    const r = result('deleteTodo');
    expect(r.outcome).toBe('failed');
    expect(r.diffs).toContainEqual({
      resource: 'GET /todos/{todoId}/comments',
      path: '$[0]',
      before: { text: 'Looks good to me' },
      after: undefined,
    });
  });

  it('catches the hidden side effect: unarchive does not reset "done"', () => {
    const r = result('archiveTodo');
    expect(r.outcome).toBe('failed');
    expect(r.diffs).toContainEqual({ resource: 'GET /todos/{todoId}', path: '$.done', before: false, after: true });
  });

  it('never executes irreversible operations', () => {
    expect(result('sendReminder').outcome).toBe('gated');
    expect(server.sentReminders).toEqual([]);
  });

  it('summarises and renders reports', () => {
    expect(report.summary).toMatchObject({ verified: 6, failed: 2, gated: 1, error: 0, skipped: 0, total: 9 });
    expect(toBadge(report)).toEqual({ schemaVersion: 1, label: 'undo verified', message: '6/8', color: 'yellow' });
    const md = toMarkdown(report);
    expect(md).toContain('## State left behind by failed undos');
    expect(md).toContain('`$.done`');
  });
});
