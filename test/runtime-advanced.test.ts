import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConflictError,
  DependencyError,
  FileJournalStore,
  loadSpec,
  parseSpec,
  ReplayBlockedError,
  UndoableClient,
  type ApiSpec,
  type ClientOptions,
} from '../src/index.js';
import { startTodoServer } from '../examples/todo-api/server.js';

let server: Awaited<ReturnType<typeof startTodoServer>>;
let spec: ApiSpec;
let dir: string;

beforeAll(async () => {
  server = await startTodoServer();
  spec = await loadSpec(new URL('../examples/todo-api/openapi.yaml', import.meta.url).pathname);
  dir = await mkdtemp(join(tmpdir(), 'undogen-'));
});
afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

const newClient = (opts: Partial<ClientOptions> = {}) => new UndoableClient({ spec, baseUrl: server.url, ...opts });
const idOf = (r: { data: unknown }) => (r.data as { id: string }).id;

/** Records every request the client sends. */
function recordingFetch() {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: unknown }> = [];
  const f: typeof fetch = async (input, init) => {
    calls.push({ method: init?.method ?? 'GET', url: String(input), headers: { ...(init?.headers as Record<string, string>) }, body: init?.body });
    return fetch(input, init);
  };
  return { calls, fetch: f };
}

describe('conflict detection', () => {
  it("refuses to undo over someone else's change, and leaves their change in place", async () => {
    const agent = newClient();
    const human = newClient();
    const id = idOf(await agent.call('createTodo', { body: { title: 'orig' } }));
    const { entry } = await agent.call('updateTodo', { params: { todoId: id }, body: { title: 'agent edit' } });
    await human.call('updateTodo', { params: { todoId: id }, body: { title: 'human edit' } });

    const err = await agent.undo(entry).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.conflicts).toEqual([{ field: 'title', expected: 'agent edit', actual: 'human edit' }]);
    expect(entry!.status).toBe('conflict');
    expect(((await agent.call('getTodo', { params: { todoId: id } })).data as { title: string }).title).toBe('human edit');
  });

  it('overwrites anyway with { force: true }', async () => {
    const agent = newClient();
    const id = idOf(await agent.call('createTodo', { body: { title: 'orig' } }));
    const { entry } = await agent.call('updateTodo', { params: { todoId: id }, body: { title: 'agent edit' } });
    await newClient().call('updateTodo', { params: { todoId: id }, body: { title: 'human edit' } });
    await agent.undo(entry, { force: true });
    expect(((await agent.call('getTodo', { params: { todoId: id } })).data as { title: string }).title).toBe('orig');
  });

  it('ignores changes to fields the agent did not write', async () => {
    const agent = newClient();
    const id = idOf(await agent.call('createTodo', { body: { title: 'orig' } }));
    const { entry } = await agent.call('updateTodo', { params: { todoId: id }, body: { title: 'agent edit' } });
    await newClient().call('updateTodo', { params: { todoId: id }, body: { done: true } });
    await agent.undo(entry);
    expect((await agent.call('getTodo', { params: { todoId: id } })).data).toMatchObject({ title: 'orig', done: true });
  });

  it('refuses to delete a created resource that someone else has since edited', async () => {
    const agent = newClient();
    const created = await agent.call('createTodo', { body: { title: 'mine' } });
    await newClient().call('updateTodo', { params: { todoId: idOf(created) }, body: { title: 'theirs now' } });
    await expect(agent.undo(created.entry)).rejects.toBeInstanceOf(ConflictError);
  });

  it('treats a created resource that is already gone as undone', async () => {
    const agent = newClient();
    const created = await agent.call('createTodo', { body: { title: 'short-lived' } });
    await newClient().call('deleteTodo', { params: { todoId: idOf(created) } });
    await agent.undo(created.entry);
    expect(created.entry!.status).toBe('undone');
    expect(created.entry!.undoWarnings).toContain('the resource was already gone');
  });

  it('sends If-Match with the ETag it checked, and an idempotency key', async () => {
    const rec = recordingFetch();
    const agent = newClient({ fetch: rec.fetch });
    const id = idOf(await agent.call('createTodo', { body: { title: 'orig' } }));
    const { entry } = await agent.call('updateTodo', { params: { todoId: id }, body: { title: 'x' } });
    await agent.undo(entry);
    const undoCall = rec.calls.at(-1)!;
    expect(undoCall.method).toBe('PATCH');
    expect(undoCall.headers['if-match']).toMatch(/^"[0-9a-f]+"$/);
    expect(undoCall.headers['Idempotency-Key']).toBe(`undogen-${agent.session}-${entry!.seq}-undo`);
  });
});

describe('ids that change on undo', () => {
  it('follows a re-created resource, so older undos address its new id', async () => {
    const agent = newClient();
    const id = idOf(await agent.call('createTodo', { body: { title: 'orig' } }));
    const session = newClient(); // a separate session: its undoAll covers only the update and the delete
    await session.call('updateTodo', { params: { todoId: id }, body: { title: 'edited' } });
    await session.call('deleteTodo', { params: { todoId: id } });
    const { failed } = await session.undoAll();
    expect(failed).toEqual([]);
    const newId = session.remapId('todoId', id);
    expect(newId).not.toBe(id);
    expect((await session.call('getTodo', { params: { todoId: newId } })).data).toMatchObject({ title: 'orig' });
    expect(session.journal[1]!.idMap).toEqual({ todoId: { [id]: newId } });
  });
});

describe('dependencies between entries', () => {
  it('refuses to undo a create that later writes still use, unless cascading', async () => {
    const agent = newClient();
    const created = await agent.call('createTodo', { body: { title: 'parent' } });
    const comment = await agent.call('createComment', { params: { todoId: idOf(created) }, body: { text: 'hi' } });

    const err = await agent.undo(created.entry).catch((e) => e);
    expect(err).toBeInstanceOf(DependencyError);
    expect(err.dependents.map((d: { seq: number }) => d.seq)).toEqual([comment.entry!.seq]);

    await agent.undo(created.entry, { cascade: true });
    expect(comment.entry!.status).toBe('undone');
    expect(created.entry!.status).toBe('undone');
    expect((await agent.call('getTodo', { params: { todoId: idOf(created) } })).status).toBe(404);
  });
});

describe('restoreChildren', () => {
  it('re-creates the children a cascading delete destroyed', async () => {
    const setup = newClient();
    const id = idOf(await setup.call('createTodo', { body: { title: 'with comments' } }));
    await setup.call('createComment', { params: { todoId: id }, body: { text: 'first' } });
    await setup.call('createComment', { params: { todoId: id }, body: { text: 'second' } });

    const agent = newClient({ restoreChildren: true });
    const del = await agent.call('deleteTodo', { params: { todoId: id } });
    expect(del.entry!.children![0]!.items).toHaveLength(2);
    await agent.undo();
    const newId = agent.remapId('todoId', id);
    const comments = (await agent.call('listComments', { params: { todoId: newId } })).data as Array<{ text: string }>;
    expect(comments.map((c) => c.text)).toEqual(['first', 'second']);
    expect(Object.keys(del.entry!.idMap!.commentId!)).toHaveLength(2);
  });
});

describe('persistent journal', () => {
  it('resumes a journal in another client and undoes by seq', async () => {
    const path = join(dir, 'journal.jsonl');
    const first = await UndoableClient.open({ spec, baseUrl: server.url, store: new FileJournalStore(path) });
    const id = idOf(await first.call('createTodo', { body: { title: 'persisted' } }));
    await first.call('updateTodo', { params: { todoId: id }, body: { title: 'changed' } });

    const second = await UndoableClient.open({ spec, baseUrl: server.url, store: new FileJournalStore(path) });
    expect(second.journal.map((e) => e.operationId)).toEqual(['createTodo', 'updateTodo']);
    await second.undo(2);
    await second.undo(1);

    const third = await UndoableClient.open({ spec, baseUrl: server.url, store: new FileJournalStore(path) });
    expect(third.journal.map((e) => e.status)).toEqual(['undone', 'undone']);
    expect((await third.call('getTodo', { params: { todoId: id } })).status).toBe(404);
  });
});

describe('irreversible replays', () => {
  it('blocks an identical irreversible call even when irreversible calls are allowed', async () => {
    const path = join(dir, 'replay.jsonl');
    const opts = { spec, baseUrl: server.url, allowIrreversible: true, store: new FileJournalStore(path) };
    const first = await UndoableClient.open(opts);
    const id = idOf(await first.call('createTodo', { body: { title: 'x' } }));
    await first.call('sendReminder', { params: { todoId: id } });
    const sent = server.sentReminders.length;

    // e.g. the agent restarted from a checkpoint and retries the same step
    const restarted = await UndoableClient.open(opts);
    await expect(restarted.call('sendReminder', { params: { todoId: id } })).rejects.toBeInstanceOf(ReplayBlockedError);
    expect(server.sentReminders.length).toBe(sent);
  });

  it('lets an approval function decide, telling it about the earlier call', async () => {
    const seen: unknown[] = [];
    const client = newClient({
      allowIrreversible: (_op, _plan, _input, ctx) => {
        seen.push(ctx.replayOf?.seq);
        return true;
      },
    });
    const id = idOf(await client.call('createTodo', { body: { title: 'x' } }));
    await client.call('sendReminder', { params: { todoId: id } });
    await client.call('sendReminder', { params: { todoId: id } });
    expect(seen).toEqual([undefined, 2]);
  });
});

describe('transport', () => {
  const tiny = parseSpec({
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    paths: {
      '/items': {
        parameters: [{ name: 'api-version', in: 'query', required: true, schema: { type: 'string' } }],
        post: {
          operationId: 'createItem',
          requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } },
          responses: { '201': { description: '', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } },
        },
      },
      '/items/{itemId}': {
        parameters: [{ name: 'api-version', in: 'query', required: true, schema: { type: 'string' } }],
        delete: { operationId: 'deleteItem', responses: { '204': { description: '' } } },
      },
    },
  });

  function scripted(responses: Array<() => Response>) {
    const calls: Array<{ method: string; url: URL; headers: Record<string, string>; body?: unknown }> = [];
    const f: typeof fetch = async (input, init) => {
      calls.push({ method: init!.method!, url: new URL(String(input)), headers: init!.headers as Record<string, string>, body: init!.body });
      return responses.shift()!();
    };
    return { calls, fetch: f };
  }
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  it('encodes form bodies, carries shared query params to the inverse, and runs auth hooks', async () => {
    const s = scripted([json(201, { id: 'i1' }), () => new Response(null, { status: 204 })]);
    let n = 0;
    const client = new UndoableClient({
      spec: tiny,
      baseUrl: 'http://api.test',
      fetch: s.fetch,
      headers: async () => ({ authorization: `Bearer token-${++n}` }),
      beforeRequest: (req) => {
        req.headers['x-signature'] = `sig:${req.method}:${req.url.pathname}`;
      },
    });
    const res = await client.call('createItem', { query: { 'api-version': '2024-01' }, body: { name: 'a' } });
    expect(String(s.calls[0]!.body)).toBe('name=a');
    expect(s.calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(res.entry!.inverse).toMatchObject({ path: '/items/i1', query: { 'api-version': '2024-01' } });

    await client.undo();
    expect(s.calls[1]!.url.search).toBe('?api-version=2024-01');
    expect(s.calls[1]!.headers.authorization).toBe('Bearer token-2');
    expect(s.calls[1]!.headers['x-signature']).toBe('sig:DELETE:/items/i1');
  });

  it('retries rate limits, honouring Retry-After', async () => {
    const s = scripted([json(429, {}, { 'retry-after': '0' }), json(201, { id: 'i2' })]);
    const client = new UndoableClient({ spec: tiny, baseUrl: 'http://api.test', fetch: s.fetch, retryDelayMs: 1 });
    const res = await client.call('createItem', { query: { 'api-version': '1' }, body: { name: 'b' } });
    expect(res.status).toBe(201);
    expect(s.calls).toHaveLength(2);
  });

  it('does not retry a non-idempotent call after a 503, but does retry the undo', async () => {
    const s = scripted([json(503, {}), json(201, { id: 'i3' }), json(503, {}), () => new Response(null, { status: 204 })]);
    const client = new UndoableClient({ spec: tiny, baseUrl: 'http://api.test', fetch: s.fetch, retryDelayMs: 1 });
    expect((await client.call('createItem', { query: { 'api-version': '1' }, body: { name: 'c' } })).status).toBe(503);
    await client.call('createItem', { query: { 'api-version': '1' }, body: { name: 'c' } });
    await client.undo();
    expect(s.calls.map((c) => c.method)).toEqual(['POST', 'POST', 'DELETE', 'DELETE']);
  });

  it('times out slow requests', async () => {
    const never: typeof fetch = (_input, init) =>
      new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));
    const client = new UndoableClient({ spec: tiny, baseUrl: 'http://api.test', fetch: never, timeoutMs: 20, retries: 0 });
    await expect(client.call('createItem', { query: { 'api-version': '1' }, body: {} })).rejects.toThrow(/timed out after 20ms/);
  });
});

describe('Twilio-style APIs', () => {
  it('restores form-encoded PascalCase fields from snake_case JSON, through .json routes', async () => {
    const { createServer } = await import('node:http');
    const queues = new Map<string, { sid: string; friendly_name: string; max_size: number }>();
    let n = 0;
    const srv = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
      const m = /^\/Accounts\/AC1\/Queues(?:\/(\w+))?\.json$/.exec(req.url ?? '');
      const send = (status: number, body?: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(body ? JSON.stringify(body) : undefined);
      if (!m) return send(404);
      if (!m[1] && req.method === 'POST') {
        const q = { sid: `QU${++n}`, friendly_name: form.FriendlyName ?? '', max_size: Number(form.MaxSize ?? 100) };
        queues.set(q.sid, q);
        return send(201, q);
      }
      const q = queues.get(m[1] ?? '');
      if (!q) return send(404);
      if (req.method === 'GET') return send(200, q);
      if (req.method === 'POST') {
        if (form.FriendlyName !== undefined) q.friendly_name = form.FriendlyName;
        if (form.MaxSize !== undefined) q.max_size = Number(form.MaxSize);
        return send(200, q);
      }
      if (req.method === 'DELETE') {
        queues.delete(q.sid);
        return send(204);
      }
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}`;
    const form = { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { FriendlyName: { type: 'string' }, MaxSize: { type: 'integer' } } } } };
    const ok = { '200': { description: '', content: { 'application/json': { schema: { type: 'object', properties: { sid: { type: 'string' } } } } } } };
    const twilio = parseSpec({
      openapi: '3.0.3',
      info: { title: 'Twilio-ish', version: '1' },
      paths: {
        '/Accounts/{AccountSid}/Queues.json': { post: { operationId: 'CreateQueue', requestBody: { content: form }, responses: { '201': ok['200'] } } },
        '/Accounts/{AccountSid}/Queues/{Sid}.json': {
          get: { operationId: 'FetchQueue', responses: ok },
          post: { operationId: 'UpdateQueue', requestBody: { content: form }, responses: ok },
          delete: { operationId: 'DeleteQueue', responses: { '204': { description: '' } } },
        },
      },
    });
    try {
      const client = new UndoableClient({ spec: twilio, baseUrl: url });
      const created = await client.call('CreateQueue', { params: { AccountSid: 'AC1' }, body: { FriendlyName: 'support', MaxSize: 10 } });
      const sid = (created.data as { sid: string }).sid;
      const upd = await client.call('UpdateQueue', { params: { AccountSid: 'AC1', Sid: sid }, body: { FriendlyName: 'sales' } });
      expect(upd.entry!.inverse!.body).toEqual({ FriendlyName: 'support' });
      expect(upd.entry!.check!.expected).toEqual({ FriendlyName: 'sales' });
      await client.undo();
      expect(queues.get(sid)!.friendly_name).toBe('support');
      await client.undo();
      expect(queues.size).toBe(0);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('review fixes', () => {
  it('does not let an irreversible call that can never be undone block undoing what it used', async () => {
    const client = newClient({ allowIrreversible: true });
    const id = idOf(await client.call('createTodo', { body: { title: 'reminded' } }));
    await client.call('sendReminder', { params: { todoId: id } });
    const { undone, failed } = await client.undoAll();
    expect(failed.map((f) => f.entry.operationId)).toEqual(['sendReminder']);
    expect(undone.map((e) => e.operationId)).toEqual(['createTodo']);
    expect((await client.call('getTodo', { params: { todoId: id } })).status).toBe(404);
  });

  it('loads an existing journal even when constructed directly, so sequence numbers never collide', async () => {
    const path = join(dir, 'constructed.jsonl');
    const first = new UndoableClient({ spec, baseUrl: server.url, store: new FileJournalStore(path) });
    await first.call('createTodo', { body: { title: 'one' } });
    const second = new UndoableClient({ spec, baseUrl: server.url, store: new FileJournalStore(path) });
    const res = await second.call('createTodo', { body: { title: 'two' } });
    expect(res.entry!.seq).toBe(2);
    expect(second.journal.map((e) => e.seq)).toEqual([1, 2]);
    expect((await new FileJournalStore(path).load()).map((e) => (e.request.body as { title: string }).title)).toEqual(['one', 'two']);
  });

  it('does not retry a POST undo after a 5xx (it could create the resource twice)', async () => {
    const calls: string[] = [];
    let deleted = false;
    const f: typeof fetch = async (input, init) => {
      const method = init!.method!;
      calls.push(method);
      if (method === 'POST' && deleted) return new Response('{}', { status: 503 });
      return fetch(input, init).then((r) => {
        if (method === 'DELETE') deleted = true;
        return r;
      });
    };
    const setup = newClient();
    const id = idOf(await setup.call('createTodo', { body: { title: 'x' } }));
    const client = newClient({ fetch: f, retryDelayMs: 1 });
    await client.call('deleteTodo', { params: { todoId: id } });
    await expect(client.undo()).rejects.toThrow(/HTTP 503/);
    expect(calls.filter((m) => m === 'POST')).toHaveLength(1);
  });
});

describe('restoreChildren: grandchildren', () => {
  it('re-creates tasks and their notes after a cascading project delete', async () => {
    const { startProjectsServer, projectsSpec } = await import('./fixtures/projects-server.js');
    const api = await startProjectsServer();
    try {
      const s = parseSpec(projectsSpec);
      const setup = new UndoableClient({ spec: s, baseUrl: api.url });
      const p = idOf(await setup.call('createProject', { body: { title: 'launch' } }));
      const t1 = idOf(await setup.call('createTask', { params: { projectId: p }, body: { title: 'design' } }));
      const t2 = idOf(await setup.call('createTask', { params: { projectId: p }, body: { title: 'build' } }));
      await setup.call('createNote', { params: { projectId: p, taskId: t1 }, body: { title: 'use blue' } });
      await setup.call('createNote', { params: { projectId: p, taskId: t2 }, body: { title: 'ship friday' } });

      const agent = new UndoableClient({ spec: s, baseUrl: api.url, restoreChildren: true });
      await agent.call('deleteProject', { params: { projectId: p } });
      expect(api.tables.notes!.size).toBe(0);
      await agent.undo();

      const np = agent.remapId('projectId', p);
      const tasks = (await agent.call('listTasks', { params: { projectId: np } })).data as Array<{ id: string; title: string }>;
      expect(tasks.map((t) => t.title)).toEqual(['design', 'build']);
      const notesOf = async (taskId: string) =>
        ((await agent.call('listNotes', { params: { projectId: np, taskId } })).data as Array<{ title: string }>).map((n) => n.title);
      expect(await notesOf(agent.remapId('taskId', t1) as string)).toEqual(['use blue']);
      expect(await notesOf(agent.remapId('taskId', t2) as string)).toEqual(['ship friday']);
      expect(agent.journal[0]!.undoWarnings).toBeUndefined();
    } finally {
      await api.close();
    }
  });
});

describe('JSON Patch and JSON Merge Patch', () => {
  async function docServer() {
    const { createServer } = await import('node:http');
    const doc: Record<string, unknown> = { title: 'orig', tags: ['a'], meta: { owner: 'ann' } };
    const srv = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      if (req.method === 'PATCH' && /json-patch/.test(req.headers['content-type'] ?? '')) {
        for (const op of body as Array<{ op: string; path: string; value?: unknown }>) {
          const [key, ...rest] = op.path.slice(1).split('/');
          if (rest.length) {
            const arr = doc[key!] as unknown[];
            if (op.op === 'add') arr.splice(rest[0] === '-' ? arr.length : Number(rest[0]), 0, op.value);
            if (op.op === 'remove') arr.splice(Number(rest[0]), 1);
            if (op.op === 'replace') arr[Number(rest[0])] = op.value;
          } else if (op.op === 'remove') delete doc[key!];
          else doc[key!] = op.value;
        }
      } else if (req.method === 'PATCH') {
        for (const [k, v] of Object.entries(body as object)) if (v === null) delete doc[k]; else doc[k] = v; // merge patch
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(doc));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    return { doc, url: `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}`, close: () => new Promise((r) => srv.close(r)) };
  }
  const specFor = (type: string) =>
    parseSpec({
      openapi: '3.0.3',
      info: { title: 'Docs', version: '1' },
      paths: {
        '/docs/{docId}': {
          get: { operationId: 'getDoc', responses: { '200': { description: '' } } },
          patch: { operationId: 'patchDoc', requestBody: { content: { [type]: { schema: type.includes('json-patch') ? { type: 'array' } : { type: 'object' } } } }, responses: { '200': { description: '' } } },
        },
      },
    });

  it('inverts a JSON Patch from the captured state', async () => {
    const api = await docServer();
    try {
      const client = new UndoableClient({ spec: specFor('application/json-patch+json'), baseUrl: api.url });
      const res = await client.call('patchDoc', {
        params: { docId: 'd1' },
        body: [
          { op: 'replace', path: '/title', value: 'new' },
          { op: 'add', path: '/tags/-', value: 'b' },
          { op: 'add', path: '/status', value: 'draft' },
          { op: 'remove', path: '/meta' },
        ],
      });
      expect(res.entry!.inverse!.body).toEqual([
        { op: 'add', path: '/title', value: 'orig' },
        { op: 'add', path: '/tags', value: ['a'] },
        { op: 'remove', path: '/status' },
        { op: 'add', path: '/meta', value: { owner: 'ann' } },
      ]);
      await client.undo();
      expect(api.doc).toEqual({ title: 'orig', tags: ['a'], meta: { owner: 'ann' } });
    } finally {
      await api.close();
    }
  });

  it('removes fields a merge patch added by sending null', async () => {
    const api = await docServer();
    try {
      const client = new UndoableClient({ spec: specFor('application/merge-patch+json'), baseUrl: api.url });
      await client.call('patchDoc', { params: { docId: 'd1' }, body: { title: 'new', status: 'draft' } });
      expect(client.journal[0]!.inverse!.body).toEqual({ title: 'orig', status: null });
      await client.undo();
      expect(api.doc).toEqual({ title: 'orig', tags: ['a'], meta: { owner: 'ann' } });
    } finally {
      await api.close();
    }
  });
});

describe('conflict checks for paired actions and toggles', () => {
  it('undoes a PUT that created a singleton (GET was 404) with the DELETE on the same route', async () => {
    const { createServer } = await import('node:http');
    let on = false;
    const srv = createServer((req, res) => {
      if (req.method === 'GET') return res.writeHead(on ? 200 : 404, { 'content-type': 'application/json' }).end(on ? '{"enabled":true}' : '{}');
      on = req.method === 'PUT';
      res.writeHead(204).end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const s = parseSpec({
      openapi: '3.0.3',
      info: { title: 'x', version: '1' },
      paths: { '/repos/{repo}/subscription': { get: { operationId: 'getSub', responses: {} }, put: { operationId: 'setSub', responses: {} }, delete: { operationId: 'deleteSub', responses: {} } } },
    });
    try {
      const client = new UndoableClient({ spec: s, baseUrl: `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}` });
      const res = await client.call('setSub', { params: { repo: 'r' }, body: { subscribed: true } });
      expect(res.entry!.inverse).toMatchObject({ method: 'delete', path: '/repos/r/subscription' });
      await client.undo();
      expect(on).toBe(false);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it("refuses to unarchive when someone else changed what archive did", async () => {
    const agent = newClient();
    const id = idOf(await agent.call('createTodo', { body: { title: 'x' } }));
    const archived = await agent.call('archiveTodo', { params: { todoId: id } });
    expect(archived.entry!.check).toMatchObject({ mode: 'diff', expected: { archived: true, done: true } });
    await newClient().call('unarchiveTodo', { params: { todoId: id } });
    const err = await agent.undo(archived.entry).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.conflicts).toEqual([{ field: 'archived', expected: true, actual: false }]);
  });

  async function starServer() {
    const { createServer } = await import('node:http');
    const starred = new Set<string>(['already']);
    const srv = createServer((req, res) => {
      const repo = (req.url ?? '').split('/').at(-2)!; // /repos/{repo}/star
      if (req.method === 'GET') return res.writeHead(starred.has(repo) ? 204 : 404).end();
      if (req.method === 'PUT' || req.method === 'POST') starred.add(repo);
      if (req.method === 'DELETE') starred.delete(repo);
      res.writeHead(204).end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    return { starred, url: `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}`, close: () => new Promise((r) => srv.close(r)) };
  }
  const starSpec = parseSpec({
    openapi: '3.0.3',
    info: { title: 'Stars', version: '1' },
    paths: {
      '/repos/{repo}/star': {
        get: { operationId: 'checkStarred', responses: { '204': { description: '' }, '404': { description: '' } } },
        post: { operationId: 'star', responses: { '204': { description: '' } } },
        delete: { operationId: 'unstar', responses: { '204': { description: '' } } },
      },
    },
  });

  it('does nothing when undoing a toggle that changed nothing (starring an already-starred repo)', async () => {
    const api = await starServer();
    try {
      const client = new UndoableClient({ spec: starSpec, baseUrl: api.url });
      const res = await client.call('star', { params: { repo: 'already' } });
      expect(res.entry!.noop).toBe(true);
      await client.undo();
      expect(api.starred.has('already')).toBe(true);
      expect(res.entry!.undoWarnings).toEqual(['the call changed nothing, so there was nothing to undo']);
    } finally {
      await api.close();
    }
  });

  it('undoes a toggle that did change something, and refuses if it was flipped back since', async () => {
    const api = await starServer();
    try {
      const client = new UndoableClient({ spec: starSpec, baseUrl: api.url });
      await client.call('star', { params: { repo: 'new' } });
      await client.undo();
      expect(api.starred.has('new')).toBe(false);

      const again = await client.call('star', { params: { repo: 'other' } });
      api.starred.delete('other'); // someone else unstarred it
      await expect(client.undo(again.entry)).rejects.toBeInstanceOf(ConflictError);
    } finally {
      await api.close();
    }
  });
});

describe('checkpoints', () => {
  it('undoes only what was done after a checkpoint', async () => {
    const client = newClient();
    const keep = idOf(await client.call('createTodo', { body: { title: 'before the task' } }));
    const cp = await client.checkpoint();
    const t = idOf(await client.call('createTodo', { body: { title: 'task' } }));
    await client.call('updateTodo', { params: { todoId: keep }, body: { title: 'touched by the task' } });
    const { undone, failed } = await client.undoTo(cp);
    expect(failed).toEqual([]);
    expect(undone.map((e) => e.operationId)).toEqual(['updateTodo', 'createTodo']);
    expect((await client.call('getTodo', { params: { todoId: t } })).status).toBe(404);
    expect((await client.call('getTodo', { params: { todoId: keep } })).data).toMatchObject({ title: 'before the task' });
  });

  it('works through the tools: checkpoint, then undo_all { to }', async () => {
    const { toolDefinitions } = await import('../src/tools.js');
    const client = newClient();
    const tools = Object.fromEntries(toolDefinitions(client, spec.operations).map((t) => [t.name, t]));
    await tools.createTodo!.execute({ body: { title: 'kept' } });
    const { checkpoint } = (await tools.undogen_checkpoint!.execute({})) as { checkpoint: number };
    await tools.createTodo!.execute({ body: { title: 'rolled back' } });
    const res = (await tools.undogen_undo_all!.execute({ to: checkpoint })) as { undone: unknown[] };
    expect(res.undone).toHaveLength(1);
    expect(client.journal.map((e) => e.status)).toEqual(['active', 'undone']);
  });
});

describe('journal compaction', () => {
  it('keeps only the latest version of each entry, atomically and owner-only', async () => {
    const { stat, readFile } = await import('node:fs/promises');
    const path = join(dir, 'compact.jsonl');
    const client = await UndoableClient.open({ spec, baseUrl: server.url, store: new FileJournalStore(path) });
    const id = idOf(await client.call('createTodo', { body: { title: 'x' } }));
    await client.call('updateTodo', { params: { todoId: id }, body: { title: 'y' } });
    await client.undoAll();
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(4);
    expect(await new FileJournalStore(path).compact()).toEqual({ before: 4, after: 2 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const reopened = await UndoableClient.open({ spec, baseUrl: server.url, store: new FileJournalStore(path) });
    expect(reopened.journal.map((e) => [e.seq, e.status])).toEqual([[1, 'undone'], [2, 'undone']]);
  });
});
