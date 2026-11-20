import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { FileJournalStore, loadSpec, UndoableClient } from '../src/index.js';
import { startTodoServer } from '../examples/todo-api/server.js';

const root = new URL('..', import.meta.url).pathname;
const tsx = join(root, 'node_modules/.bin/tsx');
const cli = join(root, 'src/cli.ts');
const spec = join(root, 'examples/todo-api/openapi.yaml');
const fixtures = join(root, 'examples/todo-api/fixtures.json');

let server: Awaited<ReturnType<typeof startTodoServer>>;
let dir: string;
beforeAll(async () => {
  server = await startTodoServer();
  dir = await mkdtemp(join(tmpdir(), 'undogen-cli-'));
});
afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(tsx, [cli, ...args], { cwd: dir, env: { ...process.env, NO_COLOR: '1' } });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe('cli', () => {
  it('prints its version from package.json', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    expect((await run('--version')).stdout.trim()).toBe(pkg.version);
  });

  it('exits 2 on usage errors', async () => {
    expect((await run('verify', spec)).code).toBe(2);
    expect((await run('frobnicate', spec)).code).toBe(2);
  });

  it('verify writes reports, JUnit and SARIF, and exits 1 on failures', async () => {
    const r = await run('verify', spec, '--base-url', server.url, '--fixtures', fixtures, '--report', 'out', '--junit', 'out/junit.xml', '--sarif', 'out/undogen.sarif', '--redact');
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('6 verified · 2 failed');
    const junit = await readFile(join(dir, 'out/junit.xml'), 'utf8');
    expect(junit).toContain('tests="9" failures="2" errors="0" skipped="1"');
    expect(junit).toMatch(/<testcase classname="undogen.compensable" name="deleteTodo \(DELETE \/todos\/\{todoId\}\)" time="0"><failure/);
    const sarif = JSON.parse(await readFile(join(dir, 'out/undogen.sarif'), 'utf8'));
    const results = sarif.runs[0].results;
    expect(results.map((x: any) => x.ruleId)).toEqual(['undo-failed', 'undo-failed']);
    const specLines = (await readFile(spec, 'utf8')).split('\n');
    expect(specLines[results[0].locations[0].physicalLocation.region.startLine - 1]).toContain('operationId: deleteTodo');
    const html = await readFile(join(dir, 'out/report.html'), 'utf8');
    expect(html).toContain('<span class="badge failed">Failed</span></td><td data-label="Operation"><code class="id">deleteTodo</code>');
    expect(html).not.toMatch(/<script|https?:\/\/(?!127)/); // self-contained
    const report = JSON.parse(await readFile(join(dir, 'out/report.json'), 'utf8'));
    const diff = report.results.find((x: any) => x.operationId === 'deleteTodo').diffs[0];
    expect(diff.before).toEqual({ text: '‹redacted string(16)›' });
  });

  it('--strict also fails on inconclusive results', async () => {
    await writeFile(join(dir, 'noop.json'), JSON.stringify({ updateTodo: { body: {} } }));
    expect((await run('verify', spec, '--base-url', server.url, '--only', 'updateTodo', '--fixtures', 'noop.json')).code).toBe(0);
    expect((await run('verify', spec, '--base-url', server.url, '--only', 'updateTodo', '--fixtures', 'noop.json', '--strict')).code).toBe(1);
  });

  it('undo and journal work on a journal written by another process', async () => {
    const journal = join(dir, 'session.jsonl');
    const s = await loadSpec(spec);
    const agent = await UndoableClient.open({ spec: s, baseUrl: server.url, store: new FileJournalStore(journal) });
    const id = ((await agent.call('createTodo', { body: { title: 'cli' } })).data as { id: string }).id;
    await agent.call('updateTodo', { params: { todoId: id }, body: { done: true } });

    expect((await run('journal', '--journal', journal)).stdout).toMatch(/#2 +active +updateTodo/);
    const one = await run('undo', spec, '--base-url', server.url, '--journal', journal);
    expect(one.stdout).toContain(`↺ #2 updateTodo  PATCH /todos/${id}`);
    const all = await run('undo', spec, '--base-url', server.url, '--journal', journal, '--all');
    expect(all.stdout).toContain(`↺ #1 createTodo  DELETE /todos/${id}`);
    expect((await fetch(`${server.url}/todos/${id}`)).status).toBe(404);
  });

  it('journal groups entries by session, and undo --session rolls back one agent run', async () => {
    const journal = join(dir, 'sessions.jsonl');
    const s = await loadSpec(spec);
    const monday = await UndoableClient.open({ spec: s, baseUrl: server.url, store: new FileJournalStore(journal) });
    const kept = ((await monday.call('createTodo', { body: { title: 'monday' } })).data as { id: string }).id;
    const tuesday = await UndoableClient.open({ spec: s, baseUrl: server.url, store: new FileJournalStore(journal) });
    const a = ((await tuesday.call('createTodo', { body: { title: 'tuesday a' } })).data as { id: string }).id;
    const b = ((await tuesday.call('createTodo', { body: { title: 'tuesday b' } })).data as { id: string }).id;

    const listed = (await run('journal', '--journal', journal)).stdout;
    expect(listed).toMatch(new RegExp(`session ${monday.session} .* · 1 write\\n`));
    expect(listed).toMatch(new RegExp(`session ${tuesday.session} .* · 2 writes\\n`));
    expect((await run('journal', '--journal', journal, '--session', tuesday.session)).stdout).not.toContain('#1 ');

    const out = await run('undo', spec, '--base-url', server.url, '--journal', journal, '--session', tuesday.session);
    expect(out.stdout.split('\n').map((l) => l.trim()).filter(Boolean)).toEqual([`↺ #3 createTodo  DELETE /todos/${b}`, `↺ #2 createTodo  DELETE /todos/${a}`]);
    expect((await fetch(`${server.url}/todos/${kept}`)).status).toBe(200);

    expect((await run('undo', spec, '--base-url', server.url, '--journal', journal, '--session', 'nope')).stderr).toMatch(/No entries for session nope/);
    expect((await run('undo', spec, '--base-url', server.url, '--journal', journal, '--seq', '1', '--all')).stderr).toMatch(/use one of/);
  });

  it('init, annotate, arazzo and compile write files', async () => {
    await run('init', spec, '--overrides-out', 'init/overrides.json', '--fixtures-out', 'init/fixtures.json');
    expect(JSON.parse(await readFile(join(dir, 'init/fixtures.json'), 'utf8')).unarchiveTodo.prepare).toEqual([{ operationId: 'archiveTodo' }]);

    await run('annotate', spec, '-o', 'annotated.yaml');
    expect(parseYaml(await readFile(join(dir, 'annotated.yaml'), 'utf8')).paths['/todos'].post['x-undogen']).toMatchObject({ inverse: 'deleteTodo' });

    expect((await run('arazzo', spec)).stdout).toContain('workflowId: undo-createTodo');

    const bundle = JSON.parse((await run('compile', spec)).stdout);
    expect(bundle.format).toBe('undogen-bundle/1');
    expect(bundle.operations).toHaveLength(13);
  });
});

describe('cli: mcp over stdio', () => {
  it('serves tools a real MCP client can call', async () => {
    const transport = new StdioClientTransport({ command: tsx, args: [cli, 'mcp', spec, '--base-url', server.url, '--only', 'createTodo,getTodo'], stderr: 'pipe' });
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['createTodo', 'getTodo', 'undogen_undo', 'undogen_undo_all', 'undogen_checkpoint', 'undogen_preview', 'undogen_journal']);
      const res = await client.callTool({ name: 'createTodo', arguments: { body: { title: 'stdio' } } });
      const id = JSON.parse((res.content as Array<{ text: string }>)[0]!.text).data.id;
      await client.callTool({ name: 'undogen_undo', arguments: {} });
      expect((await fetch(`${server.url}/todos/${id}`)).status).toBe(404);
    } finally {
      await client.close();
    }
  }, 20_000);
});

describe('examples', () => {
  it('the Claude Desktop config and the GitHub workflow are well-formed', async () => {
    const cfg = JSON.parse(await readFile(join(root, 'examples/mcp/claude_desktop_config.json'), 'utf8'));
    expect(cfg.mcpServers['todo-api'].args.slice(0, 3)).toEqual(['-y', 'undogen', 'mcp']);
    const wf = parseYaml(await readFile(join(root, 'examples/github-workflow/undogen.yml'), 'utf8'));
    expect(Object.keys(wf.jobs)).toEqual(['diff', 'verify']);
    const action = parseYaml(await readFile(join(root, 'action.yml'), 'utf8'));
    for (const key of Object.keys(wf.jobs.verify.steps[1].with)) expect(Object.keys(action.inputs)).toContain(key);
  });
});

describe('cli: review fixes', () => {
  it('rejects a non-numeric --concurrency instead of taking empty snapshots', async () => {
    const r = await run('verify', spec, '--base-url', server.url, '--concurrency', 'x');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--concurrency must be a whole number');
  });

  it('undo without --seq reports the entry it actually undid', async () => {
    const journal = join(dir, 'which.jsonl');
    const s = await loadSpec(spec);
    const agent = await UndoableClient.open({ spec: s, baseUrl: server.url, store: new FileJournalStore(journal) });
    const id = ((await agent.call('createTodo', { body: { title: 'which' } })).data as { id: string }).id;
    await agent.call('updateTodo', { params: { todoId: id }, body: { done: true } });
    await agent.undo(2); // #2 is already undone
    const out = await run('undo', spec, '--base-url', server.url, '--journal', journal);
    expect(out.stdout).toContain(`↺ #1 createTodo  DELETE /todos/${id}`);
  });
});
