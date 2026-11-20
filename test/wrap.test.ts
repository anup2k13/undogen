import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileJournalStore } from '../src/index.js';
import { planTools, resultKeysFor, type McpTool } from '../src/wrap/plans.js';
import { createWrapServer } from '../src/wrap/server.js';
import type { ToolEntry } from '../src/wrap/session.js';
import { createIssuesServer, issueTools } from './fixtures/issues-mcp-server.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'undogen-wrap-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The fixture issues server, wrapped, with an agent connected to the wrapper. */
async function setup(opts: { irreversible?: 'ask' | 'allow' | 'deny'; elicit?: boolean; journal?: string; prompts?: string[] } = {}) {
  const { server: upstreamServer, state } = createIssuesServer();
  const [up1, up2] = InMemoryTransport.createLinkedPair();
  await upstreamServer.connect(up1);
  const upstream = new Client({ name: 'undogen', version: '1' });
  await upstream.connect(up2);
  const { server, session } = await createWrapServer({ upstream, irreversible: opts.irreversible, store: opts.journal ? new FileJournalStore<ToolEntry>(opts.journal) : undefined });
  const agent = new Client({ name: 'agent', version: '1' }, { capabilities: opts.elicit !== undefined ? { elicitation: { form: {} } } : {} });
  if (opts.elicit !== undefined) {
    agent.setRequestHandler(ElicitRequestSchema, async (req) => {
      opts.prompts?.push((req.params as { message: string }).message);
      return { action: 'accept', content: { approve: opts.elicit } };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await agent.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await agent.callTool({ name, arguments: args })) as CallToolResult;
  const data = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);
  return { agent, state, call, data, session };
}

describe('planTools', () => {
  const plans = Object.fromEntries(planTools(issueTools as McpTool[]).map((p) => [p.tool, p]));

  it('finds an inverse from names and arguments alone', () => {
    expect(plans.list_issues).toMatchObject({ strategy: 'no-side-effects' });
    expect(plans.get_issue).toMatchObject({ strategy: 'no-side-effects' });
    expect(plans.update_issue).toMatchObject({ reversibility: 'reversible', strategy: 'restore-snapshot', snapshot: { tool: 'get_issue' } });
    expect(plans.add_issue_labels).toMatchObject({ strategy: 'paired-action', inverse: { tool: 'remove_issue_labels' } });
    expect(plans.star_repository).toMatchObject({ strategy: 'paired-action', inverse: { tool: 'unstar_repository' } });
    expect(plans.send_email).toMatchObject({ reversibility: 'irreversible' });
    expect(plans.create_or_update_file).toMatchObject({ reversibility: 'unknown' });
  });

  it('closes what it cannot delete, binding the new id from the result', () => {
    expect(plans.create_issue).toMatchObject({
      reversibility: 'compensable',
      strategy: 'close-created',
      inverse: { tool: 'update_issue', arguments: { repo: { from: 'args', key: 'repo' }, issue_number: { from: 'result', keys: ['issue_number', 'number'] }, state: { value: 'closed' } } },
    });
  });

  it('prefers a delete tool, and takes overrides', () => {
    const o = (props: string[]) => ({ type: 'object' as const, properties: Object.fromEntries(props.map((p) => [p, {}])), required: props });
    const tools = [
      { name: 'createPage', inputSchema: o(['title']) },
      { name: 'deletePage', inputSchema: o(['pageId']) },
      { name: 'run_job', inputSchema: o(['job']) },
    ];
    const p = planTools(tools, { run_job: { inverse: 'cancel_job', arguments: { job_id: 'result.id', reason: 'undo' } } });
    expect(p[0]).toMatchObject({ strategy: 'delete-created', inverse: { tool: 'deletePage', arguments: { pageId: { from: 'result', keys: ['pageId', 'id'] } } } });
    expect(p[1]).toMatchObject({ reversibility: 'irreversible' });
    expect(p[2]).toMatchObject({ strategy: 'declared', inverse: { tool: 'cancel_job', arguments: { job_id: { from: 'result', keys: ['id'] }, reason: { value: 'undo' } } } });
  });

  it('maps argument names to result fields', () => {
    expect(resultKeysFor('issue_number', 'issue')).toEqual(['issue_number', 'number']);
    expect(resultKeysFor('page_id', 'page')).toEqual(['page_id', 'id']);
    expect(resultKeysFor('name', 'label')).toEqual(['name']);
  });
});

describe('undogen wrap', () => {
  it('passes tools through with what undo does, and adds the undo tools', async () => {
    const { agent } = await setup();
    const { tools } = await agent.listTools();
    expect(tools.map((t) => t.name)).toEqual([...issueTools.map((t) => t.name), 'undogen_undo', 'undogen_undo_all', 'undogen_journal', 'undogen_checkpoint', 'undogen_preview']);
    expect(tools.find((t) => t.name === 'update_issue')!.description).toBe('Edit an issue.\n\nCan be undone with undogen_undo: get_issue reads the old values; update_issue writes them back.');
    expect(tools.find((t) => t.name === 'send_email')!.description).toMatch(/IRREVERSIBLE/);
    expect(agent.getInstructions()).toContain('Issue numbers are per repository.'); // the wrapped server's own instructions are kept
  });

  it('undoes a create (by closing it), an update, a label and a star', async () => {
    const { call, state, data } = await setup();
    const created = await call('create_issue', { repo: 'acme/app', title: 'Bug', body: 'it breaks' });
    expect((created.content.at(-1) as { text: string }).text).toBe('undogen: journaled as #1; undogen_undo { "seq": 1 } undoes it with update_issue.');
    const n = data(created).number;
    await call('update_issue', { repo: 'acme/app', issue_number: n, title: 'Bug in login', state: 'closed' });
    await call('add_issue_labels', { repo: 'acme/app', issue_number: n, labels: ['p1'] });
    await call('star_repository', { repo: 'acme/app' });
    await call('get_issue', { repo: 'acme/app', issue_number: n }); // reads aren't journaled
    expect(data(await call('undogen_journal')).entries.map((e: { tool: string }) => e.tool)).toEqual(['create_issue', 'update_issue', 'add_issue_labels', 'star_repository']);

    await call('undogen_undo');
    expect(state.starred.size).toBe(0);
    await call('undogen_undo');
    expect(state.issues.get(n)!.labels).toEqual([]);
    await call('undogen_undo');
    expect(state.issues.get(n)).toMatchObject({ title: 'Bug', state: 'open' });
    await call('undogen_undo');
    expect(state.issues.get(n)).toMatchObject({ state: 'closed' });
  });

  it('refuses to undo over someone else\'s change, unless forced', async () => {
    const { call, state, data } = await setup();
    const n = data(await call('create_issue', { repo: 'r', title: 'a' })).number;
    await call('update_issue', { repo: 'r', issue_number: n, title: 'b' });
    state.issues.get(n)!.title = 'edited by someone else';
    const refused = await call('undogen_undo');
    expect(refused.isError).toBe(true);
    expect(data(refused)).toMatchObject({ error: 'ToolConflictError', entry: 2, conflicts: [{ field: 'title', expected: 'b', actual: 'edited by someone else' }] });
    await call('undogen_undo', { seq: 2, force: true });
    expect(state.issues.get(n)!.title).toBe('a');
  });

  it('rolls back to a checkpoint', async () => {
    const { call, state, data } = await setup();
    const n = data(await call('create_issue', { repo: 'r', title: 'keep' })).number;
    const { checkpoint } = data(await call('undogen_checkpoint'));
    await call('update_issue', { repo: 'r', issue_number: n, title: 'task' });
    await call('star_repository', { repo: 'r' });
    const out = data(await call('undogen_undo_all', { to: checkpoint }));
    expect(out.undone.map((e: { tool: string }) => e.tool)).toEqual(['star_repository', 'update_issue']);
    expect(state.issues.get(n)).toMatchObject({ title: 'keep', state: 'open' });
  });

  it('puts irreversible and unknown calls to the human', async () => {
    const refused = await setup();
    const r = await refused.call('send_email', { to: 'a@example.com', body: 'hi' });
    expect(r.isError).toBe(true);
    expect(refused.data(r).message).toMatch(/cannot ask a human/);
    expect(refused.state.emails).toEqual([]);

    const prompts: string[] = [];
    const asked = await setup({ elicit: true, prompts });
    await asked.call('send_email', { to: 'a@example.com', api_key: 'sk_live_1', body: 'hi' });
    expect(asked.state.emails).toHaveLength(1);
    expect(prompts[0]).toBe('The agent wants to call send_email {"to":"a@example.com","api_key":"‹hidden›","body":"hi"}. It is irreversible: "send" has effects that can\'t be called back. Allow it?');

    const declined = await setup({ elicit: false });
    expect((await declined.call('create_or_update_file', { repo: 'r', path: 'a', content: 'x' })).isError).toBe(true);
    expect(declined.state.files.size).toBe(0);

    const allowed = await setup({ irreversible: 'allow' });
    const out = await allowed.call('create_or_update_file', { repo: 'r', path: 'a', content: 'x' });
    expect((out.content.at(-1) as { text: string }).text).toBe('undogen: journaled as #1; it cannot be undone (no inverse).');
  });

  it('passes errors through without journaling them', async () => {
    const { call, data } = await setup();
    const r = await call('update_issue', { repo: 'r', issue_number: 99, title: 'x' });
    expect(r.isError).toBe(true);
    expect(data(await call('undogen_journal')).entries).toEqual([]);
  });

  it('previews without calling', async () => {
    const { call, data, state } = await setup();
    expect(data(await call('undogen_preview', { tool: 'create_issue' }))).toMatchObject({ reversibility: 'compensable', undo: 'update_issue', needsApproval: false });
    expect(data(await call('undogen_preview', { tool: 'send_email' }))).toMatchObject({ needsApproval: true });
    expect(state.issues.size).toBe(0);
  });

  it('keeps a journal across restarts, and agents only undo their own session', async () => {
    const journal = join(dir, 'wrap.jsonl');
    const first = await setup({ journal });
    await first.call('star_repository', { repo: 'r' });
    const second = await setup({ journal });
    const r = await second.call('undogen_undo', { seq: 1 });
    expect(second.data(r).message).toMatch(/belongs to an earlier session/);
    expect(second.session.journal).toHaveLength(1);
    await second.session.undo(1); // a person can
    expect(second.session.journal[0]!.status).toBe('undone');
  });
});

describe('undogen wrap: reads that fail', () => {
  it("refuses to guess when the check can't read the resource", async () => {
    const { call, state, data } = await setup();
    const n = data(await call('create_issue', { repo: 'r', title: 'a' })).number;
    state.issues.delete(n); // gone, or an outage: a tool error can't say which
    const r = await call('undogen_undo');
    expect(data(r)).toMatchObject({ error: 'ToolUndoError', status: 'active' });
    expect(data(r).message).toMatch(/could not read the current state \(get_issue: Issue 1 not found\)/);
  });
});

describe('planTools with declared output schemas (shaped like the reference memory and filesystem servers)', () => {
  const arr = (items: object) => ({ type: 'array', items });
  const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object' as const, properties, required });
  const entity = { type: 'object', properties: { name: {}, entityType: {}, observations: {} } };
  const tools: McpTool[] = [
    { name: 'create_entities', inputSchema: obj({ entities: arr(entity) }), outputSchema: { type: 'object', properties: { entities: arr(entity), skipped: arr({}) } } },
    { name: 'add_observations', inputSchema: obj({ observations: arr({}) }), outputSchema: { type: 'object', properties: { results: arr({}) } } },
    { name: 'delete_entities', inputSchema: obj({ entityNames: arr({ type: 'string' }) }), annotations: { destructiveHint: true } },
    { name: 'delete_observations', inputSchema: obj({ deletions: arr({}) }), annotations: { destructiveHint: true } },
    { name: 'read_file', inputSchema: obj({ path: {} }), outputSchema: { type: 'object', properties: { content: {} } }, annotations: { readOnlyHint: true } },
    { name: 'edit_file', inputSchema: obj({ path: {}, edits: arr({}), dryRun: {} }, ['path', 'edits']), outputSchema: { type: 'object', properties: { content: {} } } },
    { name: 'move_file', inputSchema: obj({ source: {}, destination: {} }) },
  ];
  const plans = Object.fromEntries(planTools(tools).map((p) => [p.tool, p]));

  it('binds an array argument to a field of every created item', () => {
    expect(plans.create_entities).toMatchObject({ strategy: 'delete-created', inverse: { tool: 'delete_entities', arguments: { entityNames: { from: 'result', keys: ['entities[].name'] } } }, caveats: [] });
  });

  it("doesn't claim an inverse the declared outputs can't feed", () => {
    expect(plans.add_observations).toMatchObject({ reversibility: 'unknown' }); // delete_observations needs `deletions`, which nothing returns
    expect(plans.edit_file).toMatchObject({ reversibility: 'unknown', reasons: [expect.stringMatching(/read_file returns none of the values edit_file writes/)] });
  });

  it('undoes a move by moving back', () => {
    expect(plans.move_file).toMatchObject({ strategy: 'paired-action', inverse: { tool: 'move_file', arguments: { source: { from: 'args', key: 'destination' }, destination: { from: 'args', key: 'source' } } } });
  });
});

describe('undogen wrap: guesses disproved at runtime', () => {
  it('journals the call as not undoable and asks before the next one', async () => {
    const { ToolSession } = await import('../src/wrap/session.js');
    const calls: string[] = [];
    const approvals: string[] = [];
    const plans = planTools([
      { name: 'create_page', inputSchema: { type: 'object', properties: { title: {} }, required: ['title'] } },
      { name: 'delete_page', inputSchema: { type: 'object', properties: { page_id: {} }, required: ['page_id'] } },
    ]);
    expect(plans[0]!.caveats.join()).toMatch(/guessed from names/);
    const session = await ToolSession.open({
      plans,
      call: async (name) => (calls.push(name), { content: [{ type: 'text', text: '{"ok":true}' }] }), // no id in the result
      approve: async (plan) => (approvals.push(plan.tool), false),
    });
    const first = await session.call('create_page', { title: 'a' });
    expect(first.entry).toMatchObject({ inverseError: 'delete_page needs page_id, and the result (page_id / id) was not there' });
    expect(approvals).toEqual([]); // the first call looked undoable
    await expect(session.call('create_page', { title: 'b' })).rejects.toThrow(/its undo could not be worked out from a real call/);
    expect(approvals).toEqual(['create_page']);
    expect(calls).toEqual(['create_page']);
  });
});
