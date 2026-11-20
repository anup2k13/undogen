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

describe('review fixes (wrap)', () => {
  const o = (props: string[], required = props) => ({ type: 'object' as const, properties: Object.fromEntries(props.map((p) => [p, {}])), required });

  it("doesn't take compound or resource-first names for reads", () => {
    const plans = Object.fromEntries(
      planTools([
        { name: 'get_or_create_label', inputSchema: o(['name']) },
        { name: 'shopping_list_add_item', inputSchema: o(['item']) },
        { name: 'saved_view_delete', inputSchema: o(['id']) },
        { name: 'list_items', inputSchema: o([]) },
      ]).map((p) => [p.tool, p]),
    );
    expect(plans.get_or_create_label).toMatchObject({ reversibility: 'unknown' });
    expect(plans.shopping_list_add_item!.strategy).not.toBe('no-side-effects');
    expect(plans.saved_view_delete).toMatchObject({ reversibility: 'irreversible' });
    expect(plans.list_items).toMatchObject({ strategy: 'no-side-effects' });
  });

  const issueApi = (calls: string[], getFails = () => false) => {
    const issues = new Map<number, Record<string, unknown>>([[1, { number: 1, title: 'a' }]]); // no milestone, no assignee
    let next = 2;
    const call = async (name: string, args: Record<string, unknown>) => {
      calls.push(name);
      const ok = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
      if (name === 'get_issue') return getFails() || !issues.has(args.number as number) ? { isError: true, content: [{ type: 'text' as const, text: 'rate limited' }] } : ok(issues.get(args.number as number));
      if (name === 'delete_issue') return (issues.delete(args.number as number), ok({}));
      if (name === 'create_issue') return (issues.set(next, { ...args, number: next }), ok({ ...args, number: next++ }));
      if (name === 'update_issue') return (Object.assign(issues.get(args.number as number)!, args), ok(issues.get(args.number as number)));
      return { isError: true, content: [] };
    };
    const plans = planTools([
      { name: 'get_issue', inputSchema: o(['number']) },
      { name: 'create_issue', inputSchema: o(['title', 'milestone', 'assignee'], ['title']) },
      { name: 'update_issue', inputSchema: o(['number', 'title', 'assignee'], ['number']) },
      { name: 'delete_issue', inputSchema: o(['number']) },
    ]);
    return { issues, call, plans };
  };

  it('asks before writing when the snapshot read fails, instead of writing without a way back', async () => {
    const { ToolSession } = await import('../src/wrap/session.js');
    const calls: string[] = [];
    const asked: string[] = [];
    const { call, plans } = issueApi(calls, () => true);
    const session = await ToolSession.open({ call, plans, approve: async (plan) => (asked.push(plan.reasons[0]!), false) });
    await expect(session.call('delete_issue', { number: 1 })).rejects.toThrow(/get_issue could not read the current state first \(rate limited\)/);
    expect(asked).toHaveLength(1);
    expect(calls).toEqual(['get_issue']); // the delete never ran
    expect(session.planFor('delete_issue').reversibility).toBe('compensable'); // one failed read doesn't change the plan
  });

  it('re-creates a deleted item that lacks optional fields', async () => {
    const { ToolSession } = await import('../src/wrap/session.js');
    const { issues, call, plans } = issueApi([]);
    const session = await ToolSession.open({ call, plans });
    const { entry } = await session.call('delete_issue', { number: 1 });
    expect(entry!.inverse).toEqual({ tool: 'create_issue', arguments: { title: 'a' } });
    await session.undo();
    expect([...issues.values()]).toEqual([{ title: 'a', number: 2 }]);
  });

  it('says which sent fields undo cannot restore', async () => {
    const { ToolSession } = await import('../src/wrap/session.js');
    const { call, plans } = issueApi([]);
    const session = await ToolSession.open({ call, plans });
    const { entry } = await session.call('update_issue', { number: 1, title: 'b', assignee: 'bob' });
    expect(entry!.inverse!.arguments).toEqual({ number: 1, title: 'a' });
    expect(entry!.undoWarnings).toEqual(['undo will not restore assignee: get_issue returned no earlier value for it']);
  });

  it('journals a write even when the read after it fails', async () => {
    const { ToolSession } = await import('../src/wrap/session.js');
    const { call, plans } = issueApi([]);
    let reads = 0;
    const flaky = async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_issue' && ++reads > 1) throw new Error('Request timed out');
      return call(name, args);
    };
    const session = await ToolSession.open({ call: flaky, plans });
    const { entry } = await session.call('update_issue', { number: 1, title: 'b' });
    expect(session.journal).toEqual([entry]);
    expect(entry!.check).toBeUndefined();
  });

  it('keeps wrap journals and HTTP journals apart', async () => {
    const { ToolSession } = await import('../src/wrap/session.js');
    const { UndoableClient, parseSpec } = await import('../src/index.js');
    const http = join(dir, 'http.jsonl');
    await new FileJournalStore(http).save({ seq: 1, session: 's' } as never);
    await expect(ToolSession.open({ call: async () => ({ content: [] }), plans: [], store: new FileJournalStore<ToolEntry>(http) })).rejects.toThrow(/give `undogen wrap` its own --journal/);
    const tools = join(dir, 'tools.jsonl');
    await new FileJournalStore(tools).save({ seq: 1, session: 's', kind: 'tool' } as never);
    const spec = parseSpec({ openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: {} });
    await expect(UndoableClient.open({ spec, baseUrl: 'http://x', store: new FileJournalStore(tools) })).rejects.toThrow(/written by `undogen wrap`/);
  });
});

describe('undogen wrap: dependencies', () => {
  it('refuses to undo a create that later calls use, and cascades on request', async () => {
    const { call, state, data } = await setup();
    const n = data(await call('create_issue', { repo: 'r', title: 'a' })).number;
    await call('add_issue_labels', { repo: 'r', issue_number: n, labels: ['p1'] }); // uses issue #n
    await call('star_repository', { repo: 'r' }); // doesn't
    const refused = await call('undogen_undo', { seq: 1 });
    expect(data(refused)).toMatchObject({ error: 'ToolDependencyError', entry: 1, dependents: [2] });
    expect(state.issues.get(n)).toMatchObject({ state: 'open', labels: ['p1'] });

    const out = data(await call('undogen_undo', { seq: 1, cascade: true }));
    expect(out.undone).toMatchObject({ seq: 1, status: 'undone' });
    expect(state.issues.get(n)).toMatchObject({ state: 'closed', labels: [] });
    expect(state.starred.has('r')).toBe(true); // unrelated: left alone
    expect(data(await call('undogen_journal')).entries.map((e: { status: string }) => e.status)).toEqual(['undone', 'undone', 'active']);
  });

  it('matches long id-like strings anywhere, short values only by argument name', async () => {
    const { ToolSession } = await import('../src/wrap/session.js');
    const o = (props: string[]) => ({ type: 'object' as const, properties: Object.fromEntries(props.map((p) => [p, {}])), required: props });
    const plans = planTools([
      { name: 'create_board', inputSchema: o(['name']) },
      { name: 'delete_board', inputSchema: o(['board_id']) },
      { name: 'create_card', inputSchema: o(['title', 'parent']) },
      { name: 'delete_card', inputSchema: o(['card_id']) },
    ]);
    let n = 0;
    const session = await ToolSession.open({ plans, call: async () => ({ content: [{ type: 'text', text: JSON.stringify({ id: `obj_${++n}abc` }) }] }) });
    const board = await session.call('create_board', { name: 'b' });
    expect(board.entry!.created).toEqual([{ name: 'board_id', value: 'obj_1abc' }]);
    await session.call('create_card', { title: 'x', parent: 'obj_1abc' }); // the id under another name
    await session.call('create_card', { title: 'obj', parent: 'none' });
    expect(session.dependentsOf(board.entry!).map((e) => e.seq)).toEqual([2]);
  });
});

describe('undogen wrap: paired actions that changed nothing', () => {
  it("doesn't remove a label the issue already had", async () => {
    const { call, state, data } = await setup();
    const n = data(await call('create_issue', { repo: 'r', title: 'a' })).number;
    state.issues.get(n)!.labels = ['bug']; // already there, put by someone else
    await call('add_issue_labels', { repo: 'r', issue_number: n, labels: ['bug'] });
    await call('add_issue_labels', { repo: 'r', issue_number: n, labels: ['p1'] });
    await call('undogen_undo'); // p1: added by the agent, removed
    expect(state.issues.get(n)!.labels).toEqual(['bug']);
    const out = data(await call('undogen_undo')); // bug: the agent's call changed nothing
    expect(out.undone).toMatchObject({ seq: 2, status: 'undone', warnings: ['the call changed nothing, so there was nothing to undo'] });
    expect(state.issues.get(n)!.labels).toEqual(['bug']);
  });

  it('reads the parent resource for sub-resource actions', () => {
    const plans = Object.fromEntries(planTools(issueTools as McpTool[]).map((p) => [p.tool, p]));
    expect(plans.add_issue_labels).toMatchObject({ snapshot: { tool: 'get_issue' }, detectNoop: true, caveats: ['if get_issue shows the call changed nothing, undo does nothing'] });
    expect(plans.star_repository!.detectNoop).toBeUndefined(); // no way to read stars: undo calls unstar regardless
  });
});

describe('multi-action tools (shaped like GitHub\'s official MCP server)', () => {
  it('plans each action, and binds a created id from the result even when the shared schema has the field', async () => {
    const { githubTools } = await import('./fixtures/github-mcp-tools.js');
    const plans = Object.fromEntries(planTools(githubTools).map((p) => [p.dispatch ? `${p.tool}#${p.dispatch.value}` : p.tool, p]));
    expect(plans['issue_read#get']).toMatchObject({ strategy: 'no-side-effects' });
    expect(plans['issue_write#create']).toMatchObject({
      strategy: 'close-created',
      inverse: { tool: 'issue_write', arguments: { method: { value: 'update' }, issue_number: { from: 'result', keys: ['issue_number', 'number'] }, state: { value: 'closed' } } },
    });
    expect(plans['issue_write#update']).toMatchObject({ strategy: 'restore-snapshot', snapshot: { tool: 'issue_read', arguments: { method: { value: 'get' } } } });
    expect(plans['sub_issue_write#add']).toMatchObject({ strategy: 'paired-action', inverse: { tool: 'sub_issue_write', arguments: { method: { value: 'remove' } } } }); // options listed only in the description
    expect(plans['sub_issue_write#reprioritize']).toMatchObject({ reversibility: 'unknown' });
    expect(plans.update_pull_request).toMatchObject({ strategy: 'restore-snapshot', snapshot: { tool: 'pull_request_read', arguments: { method: { value: 'get' } } } });
    expect(plans.merge_pull_request).toMatchObject({ reversibility: 'irreversible' });
  });

  it('undoes them through the same tool with the right action', async () => {
    const { githubTools } = await import('./fixtures/github-mcp-tools.js');
    const { ToolSession } = await import('../src/wrap/session.js');
    const issues = new Map<number, Record<string, unknown>>();
    const calls: Array<[string, Record<string, unknown>]> = [];
    let next = 7;
    const ok = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
    const call = async (name: string, a: Record<string, unknown>) => {
      calls.push([name, a]);
      const issue = issues.get(a.issue_number as number);
      if (name === 'issue_read') return issue ? ok(issue) : { isError: true, content: [{ type: 'text' as const, text: 'not found' }] };
      if (name === 'issue_write' && a.method === 'create') return issues.set(next, { number: next, title: a.title, state: 'open' }), ok(issues.get(next++));
      if (name === 'issue_write' && a.method === 'update') return Object.assign(issue!, Object.fromEntries(Object.entries(a).filter(([k]) => ['title', 'state'].includes(k)))), ok(issue);
      return ok({});
    };
    const asked: string[] = [];
    const session = await ToolSession.open({ call, plans: planTools(githubTools), approve: async (p) => (asked.push(p.reasons[0]!), false) });
    await session.call('issue_write', { method: 'create', owner: 'o', repo: 'r', title: 'Bug' });
    await session.call('issue_write', { method: 'update', owner: 'o', repo: 'r', issue_number: 7, title: 'Bug in login' });
    expect(calls.find(([n]) => n === 'issue_read')![1]).toEqual({ method: 'get', owner: 'o', repo: 'r', issue_number: 7 });
    await session.undoAll();
    expect(issues.get(7)).toEqual({ number: 7, title: 'Bug', state: 'closed' });
    expect(calls.at(-1)).toEqual(['issue_write', { method: 'update', owner: 'o', repo: 'r', issue_number: 7, state: 'closed' }]);

    await expect(session.call('issue_write', { method: 'transfer', owner: 'o', repo: 'r' })).rejects.toThrow(/not approved/);
    expect(asked).toEqual(['issue_write has no known action method: "transfer"']);
  });
});

describe('review fixes (wrap, round 2)', () => {
  const o = (props: string[], required = props) => ({ type: 'object' as const, properties: Object.fromEntries(props.map((p) => [p, {}])), required });
  const byKey = (plans: ReturnType<typeof planTools>) => Object.fromEntries(plans.map((p) => [p.dispatch ? `${p.tool}#${p.dispatch.value}` : p.tool, p]));

  it("keeps a parent id from the arguments; only the created resource's own id comes from the result", () => {
    const p = byKey(planTools([{ name: 'create_card', inputSchema: o(['title', 'board_id'], ['title']) }, { name: 'delete_card', inputSchema: o(['card_id', 'board_id']) }]));
    expect(p.create_card!.inverse!.arguments).toEqual({ card_id: { from: 'result', keys: ['card_id', 'id'] }, board_id: { from: 'args', key: 'board_id' } });
  });

  it("never treats a multi-action tool's action argument as a field to restore", async () => {
    const { githubTools } = await import('./fixtures/github-mcp-tools.js');
    const { ToolSession } = await import('../src/wrap/session.js');
    // The issue happens to have a field named like the action argument.
    const issue = { number: 7, title: 'a', method: 'email' };
    const session = await ToolSession.open({ plans: planTools(githubTools), call: async () => ({ content: [{ type: 'text', text: JSON.stringify(issue) }] }) });
    const { entry } = await session.call('issue_write', { method: 'update', owner: 'o', repo: 'r', issue_number: 7, title: 'b' });
    expect(entry!.inverse!.arguments).toEqual({ method: 'update', owner: 'o', repo: 'r', issue_number: 7, title: 'a' });
    expect(entry!.undoWarnings).toBeUndefined();
  });

  it("doesn't read a parent resource that can't show the change", () => {
    const tools = [
      { name: 'get_repository', inputSchema: o(['repo']) },
      { name: 'add_repository_collaborator', inputSchema: o(['repo', 'user']) },
      { name: 'remove_repository_collaborator', inputSchema: o(['repo', 'user']) },
    ];
    expect(byKey(planTools(tools)).add_repository_collaborator!.detectNoop).toBeUndefined();
  });

  it('only counts a later call as dependent when it is in the same scope (owner/repo)', async () => {
    const { call, data, session } = await setup();
    const n = data(await call('create_issue', { repo: 'A', title: 'a' })).number;
    await call('add_issue_labels', { repo: 'B', issue_number: n, labels: ['p1'] }); // same number, another repo
    expect(session.dependentsOf(session.journal[0]!)).toEqual([]);
  });

  it("doesn't cascade when the undo it was asked for is refused", async () => {
    const { call, state, data } = await setup();
    const n = data(await call('create_issue', { repo: 'r', title: 'a' })).number;
    await call('add_issue_labels', { repo: 'r', issue_number: n, labels: ['p1'] });
    state.issues.get(n)!.title = 'edited by someone else';
    expect(data(await call('undogen_undo', { seq: 1, cascade: true }))).toMatchObject({ error: 'ToolConflictError' });
    expect(state.issues.get(n)!.labels).toEqual(['p1']); // the label write was left alone
  });

  it('reports what a cascade undid', async () => {
    const { call, data } = await setup();
    const n = data(await call('create_issue', { repo: 'r', title: 'a' })).number;
    await call('add_issue_labels', { repo: 'r', issue_number: n, labels: ['p1'] });
    const out = data(await call('undogen_undo', { seq: 1, cascade: true }));
    expect(out).toMatchObject({ undone: { seq: 1 }, alsoUndone: [{ seq: 2, tool: 'add_issue_labels' }] });
  });

  it('asks before a call whose flag makes it replace what undo cannot restore', async () => {
    const { githubTools } = await import('./fixtures/github-mcp-tools.js');
    const { ToolSession } = await import('../src/wrap/session.js');
    const asked: string[] = [];
    const session = await ToolSession.open({ plans: planTools(githubTools), call: async () => ({ content: [] }), approve: async (p) => (asked.push(p.reasons[0]!), true) });
    await session.call('sub_issue_write', { method: 'add', owner: 'o', repo: 'r', issue_number: 2, sub_issue_id: 42 });
    expect(asked).toEqual([]);
    await session.call('sub_issue_write', { method: 'add', owner: 'o', repo: 'r', issue_number: 2, sub_issue_id: 42, replace_parent: true });
    expect(asked).toEqual(["with replace_parent: true, sub_issue_write replaces something its undo can't put back"]);
  });

  it('names actions the way they are called, and previews which action undoes', async () => {
    const { githubTools } = await import('./fixtures/github-mcp-tools.js');
    const texts = planTools(githubTools).flatMap((p) => [...p.reasons, ...p.caveats]);
    expect(texts.filter((t) => t.includes('#'))).toEqual([]);
    expect(texts).toContain('undo calls sub_issue_write {method: "remove"} even if this call changed nothing');
    const { call, data } = await setup();
    expect(data(await call('undogen_preview', { tool: 'create_issue' }))).toMatchObject({ undo: 'update_issue', undoWith: { state: 'closed' } });
  });
});
