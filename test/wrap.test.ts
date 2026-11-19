import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createWrapServer, type WrapConfig } from '../src/wrap.js';
import { notesServer } from '../examples/notes-mcp/server.js';

async function setup(opts: { config?: WrapConfig; hideIrreversible?: boolean } = {}) {
  const upstreamImpl = notesServer();
  const [up1, up2] = InMemoryTransport.createLinkedPair();
  const upstream = new Client({ name: 'wrap-test', version: '1' });
  await Promise.all([upstreamImpl.server.connect(up2), upstream.connect(up1)]);

  const { server, plans } = await createWrapServer({ upstream, ...opts });
  const [a1, a2] = InMemoryTransport.createLinkedPair();
  const agent = new Client({ name: 'agent', version: '1' });
  await Promise.all([server.connect(a2), agent.connect(a1)]);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await agent.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    let data: any;
    try {
      data = JSON.parse(r.content[0]!.text);
    } catch {
      data = r.content[0]!.text;
    }
    return { isError: !!r.isError, data, texts: r.content.map((c) => c.text) };
  };
  return { ...upstreamImpl, agent, upstream, plans, call };
}

describe('undogen wrap: planning from tool names and schemas', () => {
  it('infers inverses without a spec', async () => {
    const { plans } = await setup();
    const p = (n: string) => plans.get(n)!;
    expect(p('list_notes').reversibility).toBe('read-only');
    expect(p('create_note')).toMatchObject({ strategy: 'delete-created', inverse: { tool: 'delete_note' } });
    expect(p('update_note')).toMatchObject({ strategy: 'restore-snapshot', capture: { tool: 'get_note' } });
    expect(p('delete_note')).toMatchObject({ reversibility: 'compensable', inverse: { tool: 'create_note' } });
    expect(p('send_note').reversibility).toBe('irreversible');
    expect(p('pin_note').reversibility).toBe('unknown');
    expect(p('create_issue')).toMatchObject({
      reversibility: 'compensable',
      strategy: 'soft-delete',
      inverse: { tool: 'update_issue', args: { state: { literal: 'closed' }, repo: { from: 'request' } } },
    });
  });

  it('tells the agent in each tool description whether it can be undone', async () => {
    const { agent } = await setup();
    const tools = Object.fromEntries((await agent.listTools()).tools.map((t) => [t.name, t]));
    expect(tools.create_note!.description).toContain('undogen_undo reverts it via delete_note');
    expect(tools.send_note!.description).toContain('CANNOT BE UNDONE');
    expect(tools.send_note!.annotations?.destructiveHint).toBe(true);
    expect(tools).toHaveProperty('undogen_undo_all');
  });
});

describe('undogen wrap: runtime', () => {
  it('journals writes, tells the agent how each will be undone, and rolls everything back', async () => {
    const { call, notes } = await setup();
    const created = await call('create_note', { title: 'Plan', body: 'draft' });
    expect(created.texts.at(-1)).toBe('[undogen] journaled as #1; undogen_undo will run delete_note {"id":"n1"}');
    await call('update_note', { id: 'n1', body: 'final' });
    await call('create_note', { title: 'Second' });
    expect(notes.size).toBe(2);

    const journal = await call('undogen_journal');
    expect(journal.data.map((e: { tool: string }) => e.tool)).toEqual(['create_note', 'update_note', 'create_note']);

    const rollback = await call('undogen_undo_all');
    expect(rollback.isError).toBe(false);
    expect(notes.size).toBe(0);
  });

  it('restores exactly the fields an update changed', async () => {
    const { call, notes } = await setup();
    await call('create_note', { title: 'Keep', body: 'original' });
    await call('update_note', { id: 'n1', body: 'changed' });
    await call('undogen_undo');
    expect(notes.get('n1')).toMatchObject({ title: 'Keep', body: 'original' });
  });

  it('refuses to undo when someone else changed the note, reporting the fields', async () => {
    const { call, upstream } = await setup();
    await call('create_note', { title: 'Shared' });
    await call('update_note', { id: 'n1', body: 'agent' });
    await upstream.callTool({ name: 'update_note', arguments: { id: 'n1', pinned: true } }); // a human, bypassing the wrapper

    const res = await call('undogen_undo');
    expect(res.isError).toBe(true);
    expect(res.data.changedSinceYourWrite).toEqual([expect.objectContaining({ path: '$.pinned', before: false, after: true })]);
    expect((await call('undogen_undo', { force: true })).isError).toBe(false);
  });

  it('re-creates a deleted note from its snapshot', async () => {
    const { call, notes } = await setup();
    await call('create_note', { title: 'Important', body: 'do not lose' });
    await call('delete_note', { id: 'n1' });
    expect(notes.size).toBe(0);
    await call('undogen_undo');
    expect([...notes.values()]).toEqual([expect.objectContaining({ title: 'Important', body: 'do not lose' })]);
  });

  it('soft-deletes a created issue using the number, not the global id', async () => {
    const { call, issues } = await setup();
    const issue = await call('create_issue', { repo: 'acme/app', title: 'Bug' });
    expect(issue.texts.at(-1)).toContain(`update_issue {"repo":"acme/app","issue_number":${issue.data.number},"state":"closed"}`);
    await call('undogen_undo');
    expect(issues.get(issue.data.number)!.state).toBe('closed');
  });

  it('passes irreversible tools through, marked as not undoable, or hides them on request', async () => {
    const { call, sent } = await setup();
    await call('create_note', { title: 'x' });
    const res = await call('send_note', { id: 'n1', to: 'a@example.com' });
    expect(sent).toEqual(['n1']);
    expect(res.texts.at(-1)).toContain('cannot be undone');

    const hidden = await setup({ hideIrreversible: true });
    const names = (await hidden.agent.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('send_note');
    expect(names).not.toContain('pin_note');
    expect((await hidden.call('send_note', { id: 'n1', to: 'x' })).isError).toBe(true);
    expect(hidden.sent).toEqual([]);
  });

  it('uses inverses declared in a config file', async () => {
    const config: WrapConfig = { tools: { pin_note: { inverse: 'update_note', args: { id: 'request.id', pinned: { literal: false } } } } };
    const { call, notes, plans } = await setup({ config });
    expect(plans.get('pin_note')!.strategy).toBe('declared');
    await call('create_note', { title: 'x' });
    await call('pin_note', { id: 'n1' });
    expect(notes.get('n1')!.pinned).toBe(true);
    await call('undogen_undo');
    expect(notes.get('n1')!.pinned).toBe(false);
  });

  it('forwards upstream errors untouched and does not journal them', async () => {
    const { call } = await setup();
    const res = await call('update_note', { id: 'missing', body: 'x' });
    expect(res.isError).toBe(true);
    expect((await call('undogen_journal')).data).toEqual([]);
  });
});
