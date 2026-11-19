import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';

/*
 * A small, ordinary MCP server (notes + issues) used by the wrap demo and tests.
 * It knows nothing about undo; `undogen wrap` adds that from the outside:
 *
 *   undogen wrap --plan -- npx tsx examples/notes-mcp/server.ts
 */

/** An ordinary MCP server that knows nothing about undo. */
export function notesServer() {
  const notes = new Map<string, { id: string; title: string; body: string; pinned: boolean }>();
  const issues = new Map<number, { id: number; number: number; title: string; state: string }>();
  const sent: string[] = [];
  let n = 0;
  const server = new Server({ name: 'notes', version: '1.0.0' }, { capabilities: { tools: {} } });
  const obj = (properties: Record<string, object>, req: string[] = []) => ({ type: 'object' as const, properties, required: req });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'list_notes', description: 'List notes', inputSchema: obj({}) },
      { name: 'get_note', description: 'Get a note', inputSchema: obj({ id: { type: 'string' } }, ['id']) },
      { name: 'create_note', description: 'Create a note', inputSchema: obj({ title: { type: 'string' }, body: { type: 'string' } }, ['title']) },
      { name: 'update_note', description: 'Update a note', inputSchema: obj({ id: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, pinned: { type: 'boolean' } }, ['id']) },
      { name: 'delete_note', description: 'Delete a note', inputSchema: obj({ id: { type: 'string' } }, ['id']) },
      { name: 'send_note', description: 'Email a note to someone', inputSchema: obj({ id: { type: 'string' }, to: { type: 'string' } }, ['id', 'to']) },
      { name: 'pin_note', description: 'Pin a note', inputSchema: obj({ id: { type: 'string' } }, ['id']) },
      { name: 'create_issue', description: 'Open an issue', inputSchema: obj({ repo: { type: 'string' }, title: { type: 'string' } }, ['repo', 'title']) },
      { name: 'get_issue', description: 'Get an issue', inputSchema: obj({ repo: { type: 'string' }, issue_number: { type: 'number' } }, ['repo', 'issue_number']) },
      {
        name: 'update_issue',
        description: 'Update an issue',
        inputSchema: obj({ repo: { type: 'string' }, issue_number: { type: 'number' }, state: { type: 'string', enum: ['open', 'closed'] } }, ['repo', 'issue_number']),
      },
    ],
  }));
  const ok = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
  const err = (msg: string) => ({ content: [{ type: 'text', text: msg }], isError: true });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const a = (req.params.arguments ?? {}) as Record<string, any>;
    switch (req.params.name) {
      case 'list_notes':
        return ok([...notes.values()]);
      case 'get_note': {
        const note = notes.get(a.id);
        // structuredContent here, JSON text elsewhere: both must work.
        return note ? { content: [{ type: 'text', text: JSON.stringify(note) }], structuredContent: note } : err('not found');
      }
      case 'create_note': {
        const note = { id: `n${++n}`, title: a.title, body: a.body ?? '', pinned: false };
        notes.set(note.id, note);
        return ok({ note });
      }
      case 'update_note': {
        const note = notes.get(a.id);
        if (!note) return err('not found');
        for (const k of ['title', 'body', 'pinned'] as const) if (k in a) (note as any)[k] = a[k];
        return ok(note);
      }
      case 'delete_note':
        return notes.delete(a.id) ? ok({ deleted: a.id }) : err('not found');
      case 'send_note':
        sent.push(a.id);
        return ok({ sent: true });
      case 'pin_note': {
        const note = notes.get(a.id);
        if (!note) return err('not found');
        note.pinned = true;
        return ok(note);
      }
      case 'create_issue': {
        const issue = { id: 900 + ++n, number: n, title: a.title, state: 'open' };
        issues.set(issue.number, issue);
        return ok(issue);
      }
      case 'get_issue': {
        const issue = issues.get(a.issue_number);
        return issue ? ok(issue) : err('not found');
      }
      case 'update_issue': {
        const issue = issues.get(a.issue_number);
        if (!issue) return err('not found');
        if (a.state) issue.state = a.state;
        return ok(issue);
      }
    }
    return err('unknown tool');
  });
  return { server, notes, issues, sent };
}

// `tsx examples/notes-mcp/server.ts` serves it over stdio.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await notesServer().server.connect(new StdioServerTransport());
}
