import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, DependencyError, FileJournalStore, learn, loadSpec, parseSpec, redactReport, UndoableClient, verify, type ApiSpec, type VerifyReport } from '../src/index.js';
import { toolDefinitions } from '../src/tools.js';
import { startTodoServer } from '../examples/todo-api/server.js';

let server: Awaited<ReturnType<typeof startTodoServer>>;
let todo: ApiSpec;
let dir: string;

beforeAll(async () => {
  server = await startTodoServer();
  todo = await loadSpec(new URL('../examples/todo-api/openapi.yaml', import.meta.url).pathname);
  dir = await mkdtemp(join(tmpdir(), 'undogen-review-'));
});
afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('minimal journals saved more than once', () => {
  it('does not hash a hash again when a reloaded entry is saved (no false conflict later)', async () => {
    const path = join(dir, 'resave.jsonl');
    const opts = { spec: todo, baseUrl: server.url, store: new FileJournalStore(path), journalDetail: 'minimal' as const };
    const other = new UndoableClient({ spec: todo, baseUrl: server.url });
    const id = ((await other.call('createTodo', { body: { title: 'original' } })).data as { id: string }).id;

    const agent = await UndoableClient.open(opts);
    await agent.call('updateTodo', { params: { todoId: id }, body: { title: 'by the agent' } });

    // Someone edits it: a second process's undo conflicts, and saves the (already hashed) entry again.
    await other.call('updateTodo', { params: { todoId: id }, body: { title: 'someone else' } });
    const second = await UndoableClient.open(opts);
    await expect(second.undo(1)).rejects.toBeInstanceOf(ConflictError);
    expect(await readFile(path, 'utf8')).not.toContain('by the agent');

    // They put it back: a third process's undo must see no conflict.
    await other.call('updateTodo', { params: { todoId: id }, body: { title: 'by the agent' } });
    const third = await UndoableClient.open(opts);
    await third.undo(1);
    expect(((await other.call('getTodo', { params: { todoId: id } })).data as { title: string }).title).toBe('original');
  });

  it('keeps body refs when a reloaded entry is saved again, so dependencies survive', async () => {
    const s = parseSpec({
      openapi: '3.0.3',
      info: { title: 'x', version: '1' },
      paths: {
        '/boards': { post: { operationId: 'createBoard', responses: { '201': { description: '', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } } } },
        '/boards/{boardId}': { delete: { operationId: 'deleteBoard', responses: {} } },
        '/cards': { post: { operationId: 'createCard', responses: { '201': { description: '', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } } } },
        '/cards/{cardId}': { delete: { operationId: 'deleteCard', responses: {} } },
      },
    });
    let n = 0;
    let failDeletes = true;
    const f: typeof fetch = async (_u, init) =>
      init?.method === 'POST' ? json({ id: `obj_${++n}abc` }, 201) : new Response(null, { status: failDeletes ? 500 : 204 });
    const path = join(dir, 'resave-refs.jsonl');
    const opts = { spec: s, baseUrl: 'http://x', fetch: f, store: new FileJournalStore(path), journalDetail: 'minimal' as const, retries: 0 };
    const first = await UndoableClient.open(opts);
    const board = await first.call('createBoard', { body: { name: 'b' } });
    await first.call('createCard', { body: { boardId: (board.data as { id: string }).id } });

    // A failed undo of the card saves its (bodiless) entry again.
    const second = await UndoableClient.open(opts);
    await expect(second.undo(2)).rejects.toThrow(/HTTP 500/);
    failDeletes = false;
    const third = await UndoableClient.open(opts);
    expect(third.journal[1]!.request.bodyRefs?.length).toBeGreaterThan(0);
    await expect(third.undo(1)).rejects.toBeInstanceOf(DependencyError);
  });
});

describe('nested expected values in minimal journals', () => {
  it('compares hashed nested fields leaf by leaf', async () => {
    let state: Record<string, unknown> = { settings: { theme: 'dark', lang: 'en' } };
    const s = parseSpec({
      openapi: '3.0.3',
      info: { title: 'x', version: '1' },
      paths: {
        '/profile': {
          get: { operationId: 'getProfile', responses: { '200': { description: '', content: { 'application/json': { schema: { type: 'object' } } } } } },
          patch: { operationId: 'patchProfile', responses: { '200': { description: '' } } },
        },
      },
    });
    const f: typeof fetch = async (_u, init) => {
      if (init?.method === 'PATCH') {
        const patch = JSON.parse(String(init.body)) as { settings: Record<string, unknown> };
        state = { settings: { ...(state.settings as object), ...patch.settings } };
      }
      return json(state);
    };
    const path = join(dir, 'nested.jsonl');
    const opts = { spec: s, baseUrl: 'http://x', fetch: f, store: new FileJournalStore(path), journalDetail: 'minimal' as const };
    const agent = await UndoableClient.open(opts);
    await agent.call('patchProfile', { body: { settings: { theme: 'light' } } });
    const later = await UndoableClient.open(opts);
    await later.undo(1); // unchanged since: no false conflict from comparing a hash to an object
    expect(state).toEqual({ settings: { theme: 'dark', lang: 'en' } });
  });
});

describe('verify with a creator that takes its id from the request', () => {
  it('creates the parent and uses the name it chose', async () => {
    const s = parseSpec({
      openapi: '3.0.3',
      info: { title: 'x', version: '1' },
      paths: {
        '/buckets': { post: { operationId: 'createBucket', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } }, responses: { '204': { description: '' } } } },
        '/buckets/{name}': { get: { operationId: 'getBucket', responses: { '200': { description: '' } } }, delete: { operationId: 'deleteBucket', responses: { '204': { description: '' } } } },
        '/buckets/{name}/policy': {
          get: { operationId: 'getPolicy', responses: { '200': { description: '', content: { 'application/json': { schema: { type: 'object', properties: { public: { type: 'boolean' } } } } } } } },
          put: { operationId: 'putPolicy', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { public: { type: 'boolean' } } } } } }, responses: { '200': { description: '' } } },
        },
      },
    });
    const buckets = new Map<string, { public: boolean }>();
    const f: typeof fetch = async (u, init) => {
      const p = new URL(String(u)).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const m = init?.method ?? 'GET';
      if (p.length === 1 && m === 'POST') {
        buckets.set((JSON.parse(String(init!.body)) as { name: string }).name, { public: false });
        return new Response(null, { status: 204 });
      }
      const b = buckets.get(p[1]!);
      if (!b) return json({ error: 'no such bucket' }, 404);
      if (p.length === 2) return m === 'DELETE' ? (buckets.delete(p[1]!), new Response(null, { status: 204 })) : json({ name: p[1] });
      if (m === 'PUT') Object.assign(b, JSON.parse(String(init!.body)));
      return json(b);
    };
    const r = await verify({ spec: s, baseUrl: 'http://x', fetch: f, only: ['putPolicy'], fixtures: { putPolicy: { body: { public: true } } } });
    expect(r.results[0]).toMatchObject({ operationId: 'putPolicy', outcome: 'verified' });
    expect(buckets.size).toBe(0); // and it was cleaned up by that name
  });
});

describe('If-Match and Content-Type on undo', () => {
  const s = parseSpec({
    openapi: '3.0.3',
    info: { title: 'x', version: '1' },
    paths: {
      '/docs/{id}': {
        get: { operationId: 'getDoc', responses: { '200': { description: '', content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' } } } } } } } },
        put: { operationId: 'putDoc', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' } } } } } }, responses: { '200': { description: '' } } },
      },
    },
  });

  it('never sends a weak ETag as If-Match, and sends a strong one', async () => {
    for (const [etag, expected] of [
      ['W/"v1"', undefined],
      ['"v1"', '"v1"'],
    ] as const) {
      let doc = { title: 'a' };
      const sent: Array<Record<string, string>> = [];
      const f: typeof fetch = async (_u, init) => {
        if (init?.method === 'PUT') {
          sent.push(init.headers as Record<string, string>);
          doc = JSON.parse(String(init.body));
        }
        return json(doc, 200, { etag });
      };
      const c = new UndoableClient({ spec: s, baseUrl: 'http://x', fetch: f });
      await c.call('putDoc', { params: { id: '1' }, body: { title: 'b' } });
      await c.undo();
      expect(doc).toEqual({ title: 'a' });
      expect(sent[1]!['if-match']).toBe(expected);
    }
  });

  it('sends one Content-Type for a body even when a configured header spells it differently', async () => {
    const sent: Array<Record<string, string>> = [];
    const f: typeof fetch = async (_u, init) => {
      if (init?.method === 'PUT') sent.push(init.headers as Record<string, string>);
      return json({ title: 'a' });
    };
    const c = new UndoableClient({ spec: s, baseUrl: 'http://x', fetch: f, headers: { 'Content-Type': 'text/plain' } });
    await c.call('putDoc', { params: { id: '1' }, body: { title: 'b' } });
    const types = Object.entries(sent[0]!).filter(([k]) => k.toLowerCase() === 'content-type');
    expect(types).toEqual([['content-type', 'application/json']]);
  });
});

describe('agent tools act on their own session', () => {
  it('undo_all leaves earlier sessions alone', async () => {
    const path = join(dir, 'sessions.jsonl');
    const opts = { spec: todo, baseUrl: server.url, store: new FileJournalStore(path) };
    const earlier = await UndoableClient.open(opts);
    const kept = ((await earlier.call('createTodo', { body: { title: 'earlier session' } })).data as { id: string }).id;

    const now = await UndoableClient.open(opts);
    await now.call('createTodo', { body: { title: 'this session' } });
    const tools = toolDefinitions(now, todo.operations, { only: [] });
    const undoAll = tools.find((t) => t.name === 'undogen_undo_all')!;
    const out = (await undoAll.execute({})) as { undone: unknown[] };
    expect(out.undone).toHaveLength(1);
    expect((await now.call('getTodo', { params: { todoId: kept } })).status).toBe(200);
    const journal = (await tools.find((t) => t.name === 'undogen_journal')!.execute({})) as { entries: unknown[] };
    expect(journal.entries).toHaveLength(1);
  });
});

describe('redacted reports', () => {
  const report: VerifyReport = {
    tool: { name: 'undogen', version: '0.0.0' },
    spec: { title: 'T', version: '1' },
    baseUrl: 'https://sandbox.example',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    results: [
      {
        operationId: 'createThing',
        method: 'POST',
        path: '/things',
        reversibility: 'reversible',
        strategy: 'delete-created',
        outcome: 'error',
        detail: 'setup: createThing returned HTTP 400 {"error":"bad","api_key":"sk_live_1","n":3} — add a fixture body',
        diffs: [],
        conflictCheck: { result: 'missed', detail: 'saw {"password":"hunter2","name":"x"}' },
      },
    ],
    summary: { verified: 0, failed: 0, inconclusive: 0, gated: 0, skipped: 0, error: 1, total: 1 },
  };

  it('masks secrets quoted in details', () => {
    const r = redactReport(report).results[0]!;
    expect(r.detail).toBe('setup: createThing returned HTTP 400 {"error":"bad","api_key":"‹redacted›","n":3} — add a fixture body');
    expect(r.conflictCheck!.detail).toBe('saw {"password":"‹redacted›","name":"x"}');
  });

  it('masks every quoted body with all', () => {
    const r = redactReport(report, { all: true }).results[0]!;
    expect(r.detail).toBe('setup: createThing returned HTTP 400 ‹redacted› — add a fixture body');
    expect(r.conflictCheck!.detail).toBe('saw ‹redacted›');
  });
});

describe('learn', () => {
  it('says when the resource it created could not be cleaned up', async () => {
    const s = parseSpec({
      openapi: '3.0.3',
      info: { title: 'Jobs', version: '1' },
      paths: {
        '/jobs': { post: { operationId: 'createJob', responses: { '201': { description: '', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } } } } } },
        '/jobs/{jobId}': { get: { operationId: 'getJob', responses: { '200': { description: '' } } }, delete: { operationId: 'deleteJob', responses: { '204': { description: '' } } } },
      },
    });
    const f: typeof fetch = async (_u, init) => (init?.method === 'POST' ? json({ status: 'queued' }, 201) : json({}, 404));
    const { attempts } = await learn({ spec: s, baseUrl: 'http://x', fetch: f });
    expect(attempts[0]).toMatchObject({ outcome: 'not-learned', detail: expect.stringMatching(/left in the sandbox/) });
  });
});

describe('external $refs that redirect', () => {
  it('refuses a same-origin ref that redirects to another origin', async () => {
    const remote = {
      openapi: '3.0.3',
      info: { title: 'Remote', version: '1' },
      paths: { '/things': { post: { operationId: 'createThing', requestBody: { content: { 'application/json': { schema: { $ref: 'schemas.json#/Thing' } } } }, responses: {} } } },
    };
    const fetched: string[] = [];
    const f: typeof fetch = async (u) => {
      fetched.push(String(u));
      if (String(u).endsWith('/openapi.json')) return json(remote);
      if (String(u).endsWith('/schemas.json')) return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
      return json({ Thing: { type: 'object' } });
    };
    const spec = await loadSpec('https://vendor.example/api/openapi.json', { fetch: f });
    expect(fetched).toEqual(['https://vendor.example/api/openapi.json', 'https://vendor.example/api/schemas.json']);
    expect(spec.warnings).toEqual([expect.stringMatching(/^External \$ref schemas\.json#\/Thing was not loaded: it redirects to http:\/\/169\.254\.169\.254\/latest\/meta-data: .*same origin/)]);
  });
});
