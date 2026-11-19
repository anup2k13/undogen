import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSpec, readJournal, UndoableClient, type ApiSpec } from '../src/index.js';
import { startTodoServer } from '../examples/todo-api/server.js';

const run = promisify(execFile);
const cli = (args: string[]) =>
  run(process.execPath, ['--import', 'tsx', new URL('../src/cli.ts', import.meta.url).pathname, ...args], {
    env: { ...process.env, NO_COLOR: '1' },
  });

let server: Awaited<ReturnType<typeof startTodoServer>>;
let spec: ApiSpec;
let dir: string;

beforeAll(async () => {
  server = await startTodoServer();
  spec = await loadSpec(new URL('../examples/todo-api/openapi.yaml', import.meta.url).pathname);
  dir = await mkdtemp(join(tmpdir(), 'undogen-journal-'));
});
afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

describe('persistent journal', () => {
  it('appends one JSON line per write and per undo', async () => {
    const journalFile = join(dir, 'a.jsonl');
    const client = new UndoableClient({ spec, baseUrl: server.url, journalFile });
    const id = ((await client.call('createTodo', { body: { title: 'x' } })).data as { id: string }).id;
    await client.call('updateTodo', { params: { todoId: id }, body: { done: true } });
    await client.undo();

    const events = (await readFile(journalFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(events.map((e) => e.type)).toEqual(['write', 'write', 'undo']);
    expect(events[2]).toMatchObject({ type: 'undo', seq: 2 });

    const entries = await readJournal(journalFile);
    expect(entries.map((e) => [e.seq, e.operationId, e.undone])).toEqual([
      [1, 'createTodo', false],
      [2, 'updateTodo', true],
    ]);
  });

  it('lets a different process roll back, without the spec', async () => {
    const journalFile = join(dir, 'b.jsonl');
    const agent = new UndoableClient({ spec, baseUrl: server.url, journalFile });
    const id = ((await agent.call('createTodo', { body: { title: 'agent' } })).data as { id: string }).id;
    await agent.call('createComment', { params: { todoId: id }, body: { text: 'hello' } });

    const later = await UndoableClient.open({ baseUrl: server.url, journalFile });
    expect(later.journal).toHaveLength(2);
    const { undone, failed } = await later.undoAll();
    expect(failed).toEqual([]);
    expect(undone.map((e) => e.operationId)).toEqual(['createComment', 'createTodo']);
    expect((await later.request('get', `/todos/${id}`)).status).toBe(404);
    expect((await readJournal(journalFile)).every((e) => e.undone)).toBe(true);
  });

  it('continues numbering when a resumed client makes new writes', async () => {
    const journalFile = join(dir, 'c.jsonl');
    await new UndoableClient({ spec, baseUrl: server.url, journalFile }).call('createTodo', { body: { title: '1' } });
    const resumed = await UndoableClient.open({ spec, baseUrl: server.url, journalFile });
    const res = await resumed.call('createTodo', { body: { title: '2' } });
    expect(res.entry!.seq).toBe(2);
  });

  it('treats a missing journal file as empty', async () => {
    expect(await readJournal(join(dir, 'nope.jsonl'))).toEqual([]);
  });
});

describe('CLI: journal and undo', () => {
  it('shows a journal and undoes from it, refusing on conflict unless --force', async () => {
    const journalFile = join(dir, 'cli.jsonl');
    const agent = new UndoableClient({ spec, baseUrl: server.url, journalFile });
    const id = ((await agent.call('createTodo', { body: { title: 'cli' } })).data as { id: string }).id;
    await agent.call('updateTodo', { params: { todoId: id }, body: { title: 'renamed by agent' } });

    const shown = await cli(['journal', journalFile]);
    expect(shown.stdout).toContain('createTodo');
    expect(shown.stdout).toContain(`PATCH /todos/${id}  {"title":"cli"}`);

    // Someone else edits the todo: undo must refuse...
    await agent.request('patch', `/todos/${id}`, { body: { done: true } });
    const refused = await cli(['undo', '--journal', journalFile, '--base-url', server.url]).catch((e) => e);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('changed after the write');

    // ...until forced.
    const forced = await cli(['undo', '--journal', journalFile, '--base-url', server.url, '--force']);
    expect(forced.stdout).toContain('#2 updateTodo undone');
    expect((await agent.request('get', `/todos/${id}`)).data).toMatchObject({ title: 'cli', done: true });
  });
});
