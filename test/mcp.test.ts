import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer, loadSpec, type ApiSpec } from '../src/index.js';
import { startTodoServer } from '../examples/todo-api/server.js';

let server: Awaited<ReturnType<typeof startTodoServer>>;
let spec: ApiSpec;

beforeAll(async () => {
  server = await startTodoServer();
  spec = await loadSpec(new URL('../examples/todo-api/openapi.yaml', import.meta.url).pathname);
});
afterAll(() => server.close());

async function connect(opts: { allowIrreversible?: boolean } = {}) {
  const { server: mcp } = await createMcpServer({ spec, baseUrl: server.url, ...opts });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { isError: !!res.isError, data: JSON.parse(res.content[0]!.text) };
  };
  return { client, call };
}

describe('MCP server', () => {
  it('exposes API operations plus undo tools, with reversibility in descriptions and annotations', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(Object.keys(byName)).toEqual(expect.arrayContaining(['createTodo', 'updateTodo', 'getTodo', 'undogen_undo', 'undogen_undo_all', 'undogen_journal']));
    expect(byName.createTodo!.description).toContain('Reversible: Undo deletes what this creates');
    expect(byName.deleteTodo!.description).toContain('Compensable');
    expect(byName.getTodo!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.updateTodo!.inputSchema.required).toEqual(['todoId', 'body']);
  });

  it('hides irreversible operations by default', async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('sendReminder');
  });

  it('exposes them as destructive when allowed, so clients ask the user', async () => {
    const { client, call } = await connect({ allowIrreversible: true });
    const tool = (await client.listTools()).tools.find((t) => t.name === 'sendReminder')!;
    expect(tool.annotations?.destructiveHint).toBe(true);
    expect(tool.description).toContain('CANNOT BE UNDONE');

    const created = await call('createTodo', { body: { title: 'remind me' } });
    const res = await call('sendReminder', { todoId: created.data.data.id });
    expect(res.data.status).toBe(202);
    expect(res.data.journal.undo).toBeNull();
  });

  it('lets an agent make changes and roll them all back', async () => {
    const { call } = await connect();
    const created = await call('createTodo', { body: { title: 'agent task' } });
    const id = created.data.data.id;
    expect(created.data.journal).toMatchObject({ seq: 1, undo: `DELETE /todos/${id}`, reversibility: 'reversible' });

    await call('updateTodo', { todoId: id, body: { done: true } });
    await call('createComment', { todoId: id, body: { text: 'done!' } });

    const journal = await call('undogen_journal');
    expect(journal.data.map((e: { operation: string }) => e.operation)).toEqual(['createTodo', 'updateTodo', 'createComment']);

    const rollback = await call('undogen_undo_all');
    expect(rollback.isError).toBe(false);
    expect(rollback.data.undone).toHaveLength(3);
    expect((await call('getTodo', { todoId: id })).data.status).toBe(404);
  });

  it('reports conflicts to the agent instead of overwriting', async () => {
    const { call } = await connect();
    const id = (await call('createTodo', { body: { title: 'shared' } })).data.data.id;
    await call('updateTodo', { todoId: id, body: { title: 'agent edit' } });
    await fetch(`${server.url}/todos/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done: true }) });

    const res = await call('undogen_undo');
    expect(res.isError).toBe(true);
    expect(res.data.changedSinceYourWrite).toEqual([expect.objectContaining({ path: '$.done', before: false, after: true })]);

    const forced = await call('undogen_undo', { force: true });
    expect(forced.isError).toBe(false);
  });

  it('returns API errors as tool errors without journaling them', async () => {
    const { call } = await connect();
    const res = await call('updateTodo', { todoId: 'missing', body: { title: 'x' } });
    expect(res.isError).toBe(true);
    expect(res.data.status).toBe(404);
    expect((await call('undogen_journal')).data).toEqual([]);
  });
});
