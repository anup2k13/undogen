import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze, loadSpec, parseSpec, type ApiSpec } from '../src/index.js';
import { annotate, toArazzo, toDeclaration } from '../src/export.js';
import { initFiles } from '../src/init.js';
import { candidateIds, learn } from '../src/learn.js';
import { createMcpServer } from '../src/mcp.js';
import { toolDefinitions } from '../src/tools.js';
import { UndoableClient } from '../src/runtime.js';
import { startTodoServer } from '../examples/todo-api/server.js';
import { parse as parseYaml } from 'yaml';

const specPath = new URL('../examples/todo-api/openapi.yaml', import.meta.url).pathname;
let server: Awaited<ReturnType<typeof startTodoServer>>;
let spec: ApiSpec;
beforeAll(async () => {
  server = await startTodoServer();
  spec = await loadSpec(specPath);
});
afterAll(() => server.close());

async function connect(opts: { elicit?: (msg: string) => { action: 'accept' | 'decline'; content?: Record<string, unknown> }; irreversible?: 'ask' | 'allow' | 'deny' } = {}) {
  const { server: mcp } = await createMcpServer({ spec, baseUrl: server.url, irreversible: opts.irreversible });
  const client = new Client({ name: 'test', version: '1' }, { capabilities: opts.elicit ? { elicitation: { form: {} } } : {} });
  const asked: string[] = [];
  if (opts.elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params.message);
      return opts.elicit!(req.params.message);
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    return { isError: !!res.isError, body: JSON.parse(text) };
  };
  return { client, call, asked };
}

describe('MCP proxy', () => {
  it('lists one tool per operation with undo-aware annotations, plus undo tools', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName)).toEqual(expect.arrayContaining(['createTodo', 'sendReminder', 'undogen_undo', 'undogen_undo_all', 'undogen_journal']));
    expect(byName.listTodos!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.createTodo!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.deleteTodo!.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
    expect(byName.sendReminder!.description).toMatch(/IRREVERSIBLE/);
    expect(byName.updateTodo!.inputSchema).toMatchObject({ required: ['todoId', 'body'] });
  });

  it('journals calls and undoes them through tools', async () => {
    const { call } = await connect();
    const created = await call('createTodo', { body: { title: 'via mcp' } });
    expect(created.body.journal).toMatchObject({ seq: 1, reversibility: 'reversible', undo: `DELETE /todos/${created.body.data.id}` });
    await call('updateTodo', { todoId: created.body.data.id, body: { title: 'edited' } });
    expect((await call('undogen_journal')).body.entries).toHaveLength(2);
    const undone = await call('undogen_undo_all');
    expect(undone.body.undone.map((e: { operationId: string }) => e.operationId)).toEqual(['updateTodo', 'createTodo']);
  });

  it('refuses irreversible calls when the client cannot ask a human', async () => {
    const { call } = await connect();
    const id = (await call('createTodo', { body: { title: 'x' } })).body.data.id;
    const sent = server.sentReminders.length;
    const res = await call('sendReminder', { todoId: id });
    expect(res.isError).toBe(true);
    expect(res.body.message).toMatch(/cannot ask a human/);
    expect(server.sentReminders.length).toBe(sent);
  });

  it('asks the human through elicitation, and asks again (flagging the repeat) for a replay', async () => {
    const { call, asked } = await connect({ elicit: () => ({ action: 'accept', content: { approve: true } }) });
    const id = (await call('createTodo', { body: { title: 'x' } })).body.data.id;
    expect((await call('sendReminder', { todoId: id })).isError).toBe(false);
    await call('sendReminder', { todoId: id });
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatch(/sendReminder .* irreversible/);
    expect(asked[1]).toMatch(/identical call already ran as #2/);
  });

  it('respects a declined elicitation', async () => {
    const { call } = await connect({ elicit: () => ({ action: 'decline' }) });
    const id = (await call('createTodo', { body: { title: 'x' } })).body.data.id;
    expect((await call('sendReminder', { todoId: id })).isError).toBe(true);
  });

  it("returns conflicts as tool errors instead of overwriting someone's change", async () => {
    const { call } = await connect();
    const id = (await call('createTodo', { body: { title: 'a' } })).body.data.id;
    await call('updateTodo', { todoId: id, body: { title: 'agent' } });
    await fetch(`${server.url}/todos/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'human' }) });
    const res = await call('undogen_undo', { seq: 2 });
    expect(res.isError).toBe(true);
    expect(res.body).toMatchObject({ error: 'ConflictError', status: 'conflict' });
  });
});

describe('framework-neutral tools', () => {
  it('filters with only (prefix globs) and can drop reads', () => {
    const client = new UndoableClient({ spec, baseUrl: server.url });
    const names = toolDefinitions(client, spec.operations, { only: ['create*'], includeReads: false, undoTools: false }).map((t) => t.name);
    expect(names).toEqual(['createTodo', 'createComment']);
  });

  it('sanitises and de-duplicates names', () => {
    const s = parseSpec({ openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: { '/a': { post: { operationId: 'repos/create', responses: {} } }, '/b': { post: { operationId: 'repos.create', responses: {} } } } });
    const client = new UndoableClient({ spec: s, baseUrl: 'http://x' });
    expect(toolDefinitions(client, s.operations, { undoTools: false }).map((t) => t.name)).toEqual(['repos_create', 'repos_create_2']);
  });
});

describe('annotate and arazzo', () => {
  it('writes declarations and links that re-analyze to the same plans', async () => {
    const source = '# Hand-written header comment\n' + (await readFile(specPath, 'utf8'));
    const analysis = analyze(spec);
    const annotated = annotate(source, analysis);
    expect(annotated.startsWith('# Hand-written header comment\n')).toBe(true);
    const again = analyze(parseSpec(annotated));
    const strip = (p: any) => ({ id: p.operationId, r: p.reversibility, s: p.strategy, c: p.confidence, inv: p.inverse, cap: p.capture, chk: p.check, idn: p.identity, miss: p.inverseIfMissing });
    expect(again.plans.map(strip)).toEqual(analysis.plans.map(strip));
    const doc = parseYaml(annotated);
    expect(doc.paths['/todos'].post.responses['201'].links.undo).toEqual({
      operationId: 'deleteTodo',
      description: 'Undo (reversible, delete-created)',
      parameters: { todoId: '$response.body#/id' },
    });
    expect(doc.paths['/todos/{todoId}'].patch.responses['200'].links).toBeUndefined(); // needs captured state
  });

  it('keeps hand-written declarations unless overwrite is set', () => {
    const src = 'openapi: 3.0.3\ninfo: {title: x, version: "1"}\npaths:\n  /a/{id}/explode:\n    post:\n      operationId: explode\n      x-undogen: {reversibility: irreversible, reason: mine}\n      responses: {"200": {description: ok}}\n';
    const out = annotate(src, analyze(parseSpec(src)));
    expect(parseYaml(out).paths['/a/{id}/explode'].post['x-undogen']).toEqual({ reversibility: 'irreversible', reason: 'mine' });
  });

  it('declares nothing for unknown plans', () => {
    expect(toDeclaration({ reversibility: 'unknown' } as any)).toBeUndefined();
  });

  it('emits an Arazzo workflow per undoable operation', () => {
    const doc = parseYaml(toArazzo(spec, analyze(spec), './openapi.yaml'));
    expect(doc.arazzo).toBe('1.0.1');
    const patch = doc.workflows.find((w: any) => w.workflowId === 'undo-updateTodo');
    expect(patch.steps.map((s: any) => s.stepId)).toEqual(['capture', 'do', 'undo']);
    expect(patch.steps[2].requestBody.payload).toEqual({ title: '$steps.capture.outputs.title', done: '$steps.capture.outputs.done' });
    const create = doc.workflows.find((w: any) => w.workflowId === 'undo-createTodo');
    const step = (id: string) => create.steps.find((s: any) => s.stepId === id);
    expect(create.steps.map((s: any) => s.stepId)).toEqual(['do', 'undo']);
    expect(step('do').outputs).toEqual({ id: '$response.body#/id' });
    expect(step('undo').parameters).toEqual([{ name: 'todoId', in: 'path', value: '$steps.do.outputs.id' }]);
    expect(doc.workflows.find((w: any) => w.workflowId === 'undo-sendReminder')).toBeUndefined();
  });
});

describe('learn', () => {
  // An API whose create returns only a Location header and an opaque "ref": the analyzer can't bind it.
  let url: string;
  let close: () => Promise<void>;
  const jobs = new Map<string, object>();
  beforeAll(async () => {
    let n = 0;
    const srv = createServer((req, res) => {
      const parts = (req.url ?? '').split('/').filter(Boolean);
      if (req.method === 'POST' && parts.length === 1) {
        const id = `job-${++n}`;
        jobs.set(id, { status: 'queued' });
        res.writeHead(201, { location: `/jobs/${id}`, 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ref: `r${n}`, status: 'queued' }));
      }
      const job = jobs.get(parts[1] ?? '');
      if (!job) return res.writeHead(404).end();
      if (req.method === 'GET') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(job));
      if (req.method === 'DELETE') {
        jobs.delete(parts[1]!);
        return res.writeHead(204).end();
      }
      res.writeHead(405).end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    close = () => new Promise((r) => srv.close(() => r()));
  });
  afterAll(() => close());

  const jobsSpec = parseSpec({
    openapi: '3.0.3',
    info: { title: 'Jobs', version: '1' },
    paths: {
      '/jobs': { post: { operationId: 'createJob', responses: { '201': { description: '', content: { 'application/json': { schema: { type: 'object', properties: { ref: { type: 'string' }, status: { type: 'string' } } } } } } } } },
      '/jobs/{jobId}': {
        get: { operationId: 'getJob', responses: { '200': { description: '' } } },
        delete: { operationId: 'deleteJob', responses: { '204': { description: '' } } },
      },
    },
  });

  it('finds the binding by experiment, cleans up, and the result verifies', async () => {
    expect(analyze(jobsSpec).plans[0]!.reversibility).toBe('unknown');
    const { learned, attempts } = await learn({ spec: jobsSpec, baseUrl: url });
    expect(attempts).toEqual([expect.objectContaining({ operationId: 'createJob', outcome: 'learned', detail: 'jobId ← location' })]);
    expect(learned.createJob).toMatchObject({ inverse: 'deleteJob', bindings: { jobId: 'location' } });
    expect(jobs.size).toBe(0);

    const plan = analyze(jobsSpec, { overrides: learned }).plans[0]!;
    const client = new UndoableClient({ spec: jobsSpec, baseUrl: url, plans: [plan] });
    await client.call('createJob', { body: {} });
    expect(jobs.size).toBe(1);
    await client.undo();
    expect(jobs.size).toBe(0);
  });

  it('ranks id-like fields first', () => {
    expect(candidateIds({ name: 'x y', meta: { uuid: 'u1' }, id: 7, count: 3 }).map((c) => c.binding)).toEqual(['response.id', 'response.meta.uuid', 'response.count']);
  });
});

describe('init', () => {
  it('writes override stubs for unknowns and prepare fixtures for paired actions', () => {
    const s = parseSpec({
      openapi: '3.0.3',
      info: { title: 'x', version: '1' },
      paths: {
        '/w/{id}/frob': { post: { operationId: 'frob', responses: {} } },
        '/w/{id}/archive': { post: { operationId: 'archiveW', responses: {} } },
        '/w/{id}/unarchive': { post: { operationId: 'unarchiveW', responses: {} } },
      },
    });
    const { overrides, fixtures } = initFiles(s, analyze(s));
    expect(overrides.frob).toMatchObject({ inverse: '', _candidates: ['archiveW', 'unarchiveW'] });
    expect(fixtures).toEqual({ unarchiveW: expect.objectContaining({ prepare: [{ operationId: 'archiveW' }] }) });
    // The generated files are valid as-is.
    expect(() => analyze(s, { overrides })).not.toThrow();
    expect(analyze(s, { overrides }).plans.find((p) => p.operationId === 'frob')!.reversibility).toBe('unknown');
  });

  it('adds body templates for operations that errored in a verify report', () => {
    const report = { results: [{ operationId: 'createTodo', outcome: 'error', detail: 'HTTP 400' }] } as any;
    const { fixtures } = initFiles(spec, analyze(spec), report);
    expect(fixtures.createTodo).toMatchObject({ body: { title: 'Write the README', done: false }, _note: 'error: HTTP 400' });
    expect(fixtures.unarchiveTodo).toMatchObject({ prepare: [{ operationId: 'archiveTodo' }] });
  });
});

describe('tools: header parameters', () => {
  it('exposes header parameters and sends them', async () => {
    const s = parseSpec({
      openapi: '3.0.3',
      info: { title: 'x', version: '1' },
      paths: { '/things': { get: { operationId: 'listThings', parameters: [{ name: 'X-Tenant', in: 'header', required: true, schema: { type: 'string' } }], responses: {} } } },
    });
    const seen: Record<string, string>[] = [];
    const f: typeof fetch = async (_u, init) => {
      seen.push(init!.headers as Record<string, string>);
      return new Response('[]', { status: 200 });
    };
    const client = new UndoableClient({ spec: s, baseUrl: 'http://x', fetch: f });
    const [tool] = toolDefinitions(client, s.operations, { undoTools: false });
    expect(tool!.inputSchema).toMatchObject({ required: ['headers'], properties: { headers: { required: ['X-Tenant'] } } });
    await tool!.execute({ headers: { 'X-Tenant': 'acme' } });
    expect(seen[0]!['X-Tenant']).toBe('acme');
  });
});

describe('tools: undogen_preview', () => {
  it('explains what undo would do before the agent acts, without calling the API', async () => {
    const calls: string[] = [];
    const f: typeof fetch = async (u) => {
      calls.push(String(u));
      return new Response('{}');
    };
    const client = new UndoableClient({ spec, baseUrl: 'http://x', fetch: f });
    const preview = toolDefinitions(client, spec.operations).find((t) => t.name === 'undogen_preview')!;
    expect(await preview.execute({ tool: 'createTodo' })).toMatchObject({
      reversibility: 'reversible',
      needsApproval: false,
      undo: 'DELETE /todos/{todoId} (todoId ← response.id)',
    });
    expect(await preview.execute({ tool: 'replaceTodo' })).toMatchObject({ capture: 'GET /todos/{todoId}', undoIfNew: 'DELETE /todos/{todoId}' });
    expect(await preview.execute({ tool: 'sendReminder' })).toMatchObject({ reversibility: 'irreversible', needsApproval: true, undo: null });
    expect(await preview.execute({ tool: 'getTodo' })).toMatchObject({ reversibility: 'read-only' });
    await expect(preview.execute({ tool: 'nope' })).rejects.toThrow(/Unknown tool/);
    expect(calls).toEqual([]);
  });
});
