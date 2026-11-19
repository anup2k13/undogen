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

describe('verify: trustworthy outcomes', () => {
  let spec: Awaited<ReturnType<typeof loadSpec>>;
  beforeAll(async () => {
    spec = await loadSpec(new URL('../examples/todo-api/openapi.yaml', import.meta.url).pathname);
  });
  const count = async () => ((await (await fetch(`${server.url}/todos`)).json()) as unknown[]).length;

  it('reports an operation that changed nothing as inconclusive, not verified', async () => {
    const r = await verify({ spec, baseUrl: server.url, only: ['updateTodo'], fixtures: { updateTodo: { body: {} } } });
    expect(r.results[0]).toMatchObject({ outcome: 'inconclusive' });
    expect(r.summary.inconclusive).toBe(1);
  });

  it('cleans up every resource it created', async () => {
    const before = await count();
    await verify({ spec, baseUrl: server.url, fixtures });
    expect(await count()).toBe(before);
  });

  it('keeps them with cleanup: false', async () => {
    const before = await count();
    await verify({ spec, baseUrl: server.url, fixtures, only: ['updateTodo'], cleanup: false });
    expect(await count()).toBe(before + 1);
  });

  it('verifies deleteTodo once children are re-created (restoreChildren)', async () => {
    const r = await verify({ spec, baseUrl: server.url, fixtures, only: ['deleteTodo'], restoreChildren: true });
    expect(r.results[0]).toMatchObject({ outcome: 'verified', detail: 'state restored (2 resources re-created under new ids)' });
  });

  it('still tests creates when only scoped routes are snapshotted', async () => {
    const r = await verify({ spec, baseUrl: server.url, fixtures, only: ['createTodo', 'updateTodo'], scopedOnly: true });
    expect(r.results.map((x) => x.outcome)).toEqual(['verified', 'verified']);
  });
});

describe('verify: pagination and parallel snapshots', () => {
  it('follows Link rel="next" so a side effect on page 2 is caught', async () => {
    const { createServer } = await import('node:http');
    const { parseSpec } = await import('../src/index.js');
    const items = new Map<string, { id: string; name: string; flagged: boolean }>([
      ['a', { id: 'a', name: 'first', flagged: false }],
      ['b', { id: 'b', name: 'second', flagged: false }],
    ]);
    let n = 0;
    const srv = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const url = new URL(req.url!, 'http://x');
      const parts = url.pathname.replace(/^\/api/, '').split('/').filter(Boolean);
      const send = (status: number, data?: unknown, headers: Record<string, string> = {}) =>
        res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(data === undefined ? undefined : JSON.stringify(data));
      if (parts.length === 1) {
        if (req.method === 'POST') {
          const it = { id: `n${++n}`, name: body.name ?? 'x', flagged: false };
          items.set(it.id, it);
          return send(201, it);
        }
        const page = Number(url.searchParams.get('page') ?? 1);
        const all = [...items.values()];
        const next: Record<string, string> = page < all.length ? { link: `</api/items?page=${page + 1}>; rel="next"` } : {};
        return send(200, all.slice(page - 1, page), next);
      }
      const it = items.get(parts[1]!);
      if (!it) return send(404, {});
      if (req.method === 'GET') return send(200, it);
      if (req.method === 'PATCH') {
        Object.assign(it, body);
        items.get('b')!.flagged = true; // BUG: a hidden side effect on another record, only visible on page 2
        return send(200, it);
      }
      if (req.method === 'DELETE') {
        items.delete(it.id);
        return send(204);
      }
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}/api`;
    const item = { type: 'object', properties: { id: { type: 'string', readOnly: true }, name: { type: 'string' }, flagged: { type: 'boolean' } } };
    const json = (schema: object) => ({ content: { 'application/json': { schema } } });
    const s = parseSpec({
      openapi: '3.0.3',
      info: { title: 'Paged', version: '1' },
      paths: {
        '/items': { get: { operationId: 'listItems', responses: { '200': { description: '', ...json({ type: 'array', items: item }) } } }, post: { operationId: 'createItem', requestBody: json(item), responses: { '201': { description: '', ...json(item) } } } },
        '/items/{itemId}': {
          get: { operationId: 'getItem', responses: { '200': { description: '', ...json(item) } } },
          patch: { operationId: 'updateItem', requestBody: json({ type: 'object', properties: { name: { type: 'string' } } }), responses: { '200': { description: '', ...json(item) } } },
          delete: { operationId: 'deleteItem', responses: { '204': { description: '' } } },
        },
      },
    });
    try {
      const firstPageOnly = await verify({ spec: s, baseUrl: base, only: ['updateItem'], maxPages: 1 });
      items.get('b')!.flagged = false;
      const paged = await verify({ spec: s, baseUrl: base, only: ['updateItem'], concurrency: 8 });
      expect(firstPageOnly.results[0]!.outcome, firstPageOnly.results[0]!.detail).toBe('verified');
      expect(paged.results[0]).toMatchObject({
        outcome: 'failed',
        diffs: [{ resource: 'GET /items', path: '$[1].flagged', before: false, after: true }],
      });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('parses Link headers and stays on the same API', async () => {
    const { nextLink } = await import('../src/verify.js');
    expect(nextLink('<https://api.x.com/v1/items?page=2>; rel="next", <https://api.x.com/v1/items?page=9>; rel="last"', 'https://api.x.com/v1')).toBe('/items?page=2');
    expect(nextLink('</v1/items?cursor=abc>; rel=next', 'https://api.x.com/v1/')).toBe('/items?cursor=abc');
    expect(nextLink('<https://evil.example/items?page=2>; rel="next"', 'https://api.x.com/v1')).toBeUndefined();
    expect(nextLink('<https://api.x.com/v1/items?page=1>; rel="prev"', 'https://api.x.com/v1')).toBeUndefined();
  });
});

describe('toHtml', () => {
  it('escapes every value', async () => {
    const { toHtml } = await import('../src/index.js');
    const html = toHtml({
      ...report,
      spec: { title: '<img src=x onerror=alert(1)>', version: '1' },
      results: [{ ...report.results[0]!, outcome: 'failed', detail: '<b>x</b>', diffs: [{ resource: 'GET /x', path: '$.a', before: '<script>', after: 1 }] }],
    });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
