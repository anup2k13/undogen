import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IrreversibleOperationError, loadSpec, UndoableClient, UndoConflictError, UndoError, type ApiSpec } from '../src/index.js';
import { startTodoServer } from '../examples/todo-api/server.js';

let server: Awaited<ReturnType<typeof startTodoServer>>;
let spec: ApiSpec;

beforeAll(async () => {
  server = await startTodoServer();
  spec = await loadSpec(new URL('../examples/todo-api/openapi.yaml', import.meta.url).pathname);
});
afterAll(() => server.close());

const newClient = (opts: Partial<ConstructorParameters<typeof UndoableClient>[0]> = {}) =>
  new UndoableClient({ spec, baseUrl: server.url, ...opts });

describe('UndoableClient', () => {
  it('journals a create and undoes it', async () => {
    const client = newClient();
    const res = await client.call('createTodo', { body: { title: 'a' } });
    const id = (res.data as { id: string }).id;
    expect(res.entry!.inverse).toEqual({ operationId: 'deleteTodo', method: 'delete', path: `/todos/${id}`, body: undefined });
    await client.undo();
    expect((await client.call('getTodo', { params: { todoId: id } })).status).toBe(404);
  });

  it('captures state before a PATCH and restores exactly the patched keys', async () => {
    const client = newClient();
    const created = await client.call('createTodo', { body: { title: 'original', done: false } });
    const id = (created.data as { id: string }).id;
    const patched = await client.call('updateTodo', { params: { todoId: id }, body: { title: 'changed' } });
    expect(patched.entry!.before).toMatchObject({ title: 'original', done: false });
    expect(patched.entry!.inverse!.body).toEqual({ title: 'original' });
    await client.undo(patched.entry);
    expect((await client.call('getTodo', { params: { todoId: id } })).data).toMatchObject({ title: 'original', done: false });
  });

  it('blocks irreversible operations by default and never sends the request', async () => {
    const client = newClient();
    const id = ((await client.call('createTodo', { body: { title: 'x' } })).data as { id: string }).id;
    const sentBefore = server.sentReminders.length;
    await expect(client.call('sendReminder', { params: { todoId: id } })).rejects.toBeInstanceOf(IrreversibleOperationError);
    expect(server.sentReminders.length).toBe(sentBefore);
  });

  it('lets an approval callback allow an irreversible call, and refuses to undo it', async () => {
    const approvals: string[] = [];
    const client = newClient({
      allowIrreversible: (op) => {
        approvals.push(op.id);
        return true;
      },
    });
    const id = ((await client.call('createTodo', { body: { title: 'x' } })).data as { id: string }).id;
    const res = await client.call('sendReminder', { params: { todoId: id } });
    expect(res.status).toBe(202);
    expect(approvals).toEqual(['sendReminder']);
    await expect(client.undo(res.entry)).rejects.toBeInstanceOf(UndoError);
  });

  it('does not journal failed calls', async () => {
    const client = newClient();
    const res = await client.call('updateTodo', { params: { todoId: 'nope' }, body: { title: 'x' } });
    expect(res.status).toBe(404);
    expect(client.journal).toHaveLength(0);
  });

  it('rolls back a whole session in reverse order with undoAll()', async () => {
    const client = newClient();
    const id = ((await client.call('createTodo', { body: { title: 'session' } })).data as { id: string }).id;
    await client.call('createComment', { params: { todoId: id }, body: { text: 'hi' } });
    await client.call('updateTodo', { params: { todoId: id }, body: { done: true } });
    const { undone, failed } = await client.undoAll();
    expect(failed).toEqual([]);
    expect(undone.map((e) => e.operationId)).toEqual(['updateTodo', 'createComment', 'createTodo']);
    expect((await client.call('getTodo', { params: { todoId: id } })).status).toBe(404);
  });

  describe('safe undo', () => {
    const human = () => newClient(); // a second actor changing things behind the agent's back

    it('refuses to undo a PATCH when someone changed the record afterwards, and reports what changed', async () => {
      const agent = newClient();
      const id = ((await agent.call('createTodo', { body: { title: 'draft' } })).data as { id: string }).id;
      const patched = await agent.call('updateTodo', { params: { todoId: id }, body: { title: 'agent title' } });
      await human().request('patch', `/todos/${id}`, { body: { done: true } });

      const err = await agent.undo(patched.entry).catch((e) => e);
      expect(err).toBeInstanceOf(UndoConflictError);
      expect(err.diffs).toEqual([{ resource: `GET /todos/${id}`, path: '$.done', before: false, after: true }]);
      // Nothing was overwritten.
      expect((await agent.call('getTodo', { params: { todoId: id } })).data).toMatchObject({ title: 'agent title', done: true });
    });

    it('undoes anyway with { force: true }', async () => {
      const agent = newClient();
      const id = ((await agent.call('createTodo', { body: { title: 'draft' } })).data as { id: string }).id;
      const patched = await agent.call('updateTodo', { params: { todoId: id }, body: { title: 'agent title' } });
      await human().request('patch', `/todos/${id}`, { body: { done: true } });
      await agent.undo(patched.entry, { force: true });
      expect((await agent.call('getTodo', { params: { todoId: id } })).data).toMatchObject({ title: 'draft', done: true });
    });

    it('refuses to delete a created record that someone has since edited', async () => {
      const agent = newClient();
      const id = ((await agent.call('createTodo', { body: { title: 'mine' } })).data as { id: string }).id;
      await human().request('patch', `/todos/${id}`, { body: { title: 'now theirs' } });
      await expect(agent.undo()).rejects.toBeInstanceOf(UndoConflictError);
      expect((await agent.call('getTodo', { params: { todoId: id } })).status).toBe(200);
    });

    it('treats a created record that is already gone as undone', async () => {
      const agent = newClient();
      const id = ((await agent.call('createTodo', { body: { title: 'temp' } })).data as { id: string }).id;
      await human().request('delete', `/todos/${id}`);
      const res = await agent.undo();
      expect(res.status).toBe(404);
      expect(agent.journal[0]!.undone).toBe(true);
    });

    it('ignores timestamps when comparing', async () => {
      const agent = newClient();
      const id = ((await agent.call('createTodo', { body: { title: 't' } })).data as { id: string }).id;
      const patched = await agent.call('updateTodo', { params: { todoId: id }, body: { title: 'u' } });
      await human().request('patch', `/todos/${id}`, { body: {} }); // only bumps updatedAt
      await expect(agent.undo(patched.entry)).resolves.toMatchObject({ status: 200 });
    });
  });
});
