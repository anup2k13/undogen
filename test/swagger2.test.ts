import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze, loadSpec, parseSpec, UndoableClient, verify, type ApiSpec, type VerifyReport } from '../src/index.js';
import { startTodoServer } from '../examples/todo-api/server.js';
import fixtures from '../examples/todo-api/fixtures.json' with { type: 'json' };

const dir = new URL('../examples/todo-api/', import.meta.url).pathname;

describe('Swagger 2.0 parsing', () => {
  let v2: ApiSpec;
  let v3: ApiSpec;
  beforeAll(async () => {
    v2 = await loadSpec(dir + 'swagger2.yaml');
    v3 = await loadSpec(dir + 'openapi.yaml');
  });

  it('reads basePath, body parameters, formData parameters and response schemas', () => {
    expect(v2.basePath).toBe('/v1');
    const byId = Object.fromEntries(v2.operations.map((o) => [o.id, o]));
    expect(byId.createTodo).toMatchObject({ requestRequired: true, requestSchema: { required: ['title'] } });
    expect(byId.createTodo!.requestFormat).toBeUndefined();
    expect(byId.createComment).toMatchObject({
      requestFormat: 'form',
      requestRequired: true,
      requestSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string', example: 'Looks good to me' } } },
    });
    expect(byId.getTodo!.responseSchema!.properties).toHaveProperty('id');
    expect(byId.deleteComment!.pathParams).toEqual(['todoId', 'commentId']);
  });

  it('compiles the same undo plans as the equivalent OpenAPI 3 spec', () => {
    const strip = (spec: ApiSpec) =>
      analyze(spec).plans.map((p) => ({ id: p.operationId, r: p.reversibility, s: p.strategy, inv: p.inverse?.path, body: p.inverse?.body }));
    expect(strip(v2)).toEqual(strip(v3));
  });

  it('takes the base path from OpenAPI 3 servers[0].url', () => {
    const spec = parseSpec({ openapi: '3.0.3', info: { title: 't', version: '1' }, servers: [{ url: 'https://api.example.com/v2/' }], paths: {} });
    expect(spec.basePath).toBe('/v2');
    const templated = parseSpec({ openapi: '3.0.3', info: { title: 't', version: '1' }, servers: [{ url: 'https://{region}.example.com/v2' }], paths: {} });
    expect(templated.basePath).toBeUndefined();
  });
});

describe('Swagger 2.0 end to end (basePath /v1, form-encoded comments)', () => {
  let server: Awaited<ReturnType<typeof startTodoServer>>;
  let spec: ApiSpec;
  let report: VerifyReport;

  beforeAll(async () => {
    server = await startTodoServer(0, { prefix: '/v1' });
    spec = await loadSpec(dir + 'swagger2.yaml');
    report = await verify({ spec, baseUrl: server.url, fixtures });
  });
  afterAll(() => server.close());

  it('verifies against a server under the base path, catching the same two bugs', () => {
    const outcome = Object.fromEntries(report.results.map((r) => [r.operationId, r.outcome]));
    expect(report.summary).toMatchObject({ verified: 6, failed: 2, gated: 1, error: 0 });
    expect(outcome).toMatchObject({ deleteTodo: 'failed', archiveTodo: 'failed', createComment: 'verified', deleteComment: 'verified' });
  });

  it('sends form-encoded bodies and journals full paths, so undo works without the spec', async () => {
    const client = new UndoableClient({ spec, baseUrl: server.url });
    const todo = await client.call('createTodo', { body: { title: 'v2' } });
    const id = (todo.data as { id: string }).id;
    const comment = await client.call('createComment', { params: { todoId: id }, body: { text: 'sent as a form' } });
    expect(comment.status).toBe(201);
    expect(comment.data).toMatchObject({ text: 'sent as a form' });
    expect(comment.entry!.request).toMatchObject({ path: `/v1/todos/${id}/comments`, format: 'form' });
    expect(comment.entry!.inverse!.path).toBe(`/v1/todos/${id}/comments/${(comment.data as { id: string }).id}`);

    const later = new UndoableClient({ baseUrl: server.url });
    later.journal.push(...client.journal);
    const { failed } = await later.undoAll();
    expect(failed).toEqual([]);
    expect((await later.request('get', `/v1/todos/${id}`)).status).toBe(404);
  });

  it('does not double the base path when the base URL already includes it', async () => {
    const client = new UndoableClient({ spec, baseUrl: `${server.url}/v1` });
    expect(client.basePath).toBe('');
    const res = await client.call('createTodo', { body: { title: 'once' } });
    expect(res.status).toBe(201);
  });
});
