/**
 * A small MCP server shaped like a typical issue tracker's, for testing
 * `undogen wrap`. State is in memory; `state` lets tests act as "someone else".
 *
 *   tsx test/fixtures/issues-mcp-server.ts      (stdio)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';

interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
}

const str = { type: 'string' };
const ids = { repo: str, issue_number: { type: 'integer' } };

export const issueTools = [
  { name: 'list_issues', description: 'List issues.', inputSchema: { type: 'object', properties: { repo: str }, required: ['repo'] }, annotations: { readOnlyHint: true } },
  {
    name: 'get_issue',
    description: 'Get an issue.',
    inputSchema: { type: 'object', properties: ids, required: ['repo', 'issue_number'] },
    outputSchema: { type: 'object', properties: { number: { type: 'integer' }, title: str, body: str, state: str, labels: { type: 'array', items: str } } },
  },
  { name: 'create_issue', description: 'Open an issue.', inputSchema: { type: 'object', properties: { repo: str, title: str, body: str }, required: ['repo', 'title'] } },
  {
    name: 'update_issue',
    description: 'Edit an issue.',
    inputSchema: { type: 'object', properties: { ...ids, title: str, body: str, state: { type: 'string', enum: ['open', 'closed'] } }, required: ['repo', 'issue_number'] },
  },
  { name: 'add_issue_labels', description: 'Add labels.', inputSchema: { type: 'object', properties: { ...ids, labels: { type: 'array', items: str } }, required: ['repo', 'issue_number', 'labels'] } },
  { name: 'remove_issue_labels', description: 'Remove labels.', inputSchema: { type: 'object', properties: { ...ids, labels: { type: 'array', items: str } }, required: ['repo', 'issue_number', 'labels'] } },
  { name: 'star_repository', description: 'Star a repository.', inputSchema: { type: 'object', properties: { repo: str }, required: ['repo'] } },
  { name: 'unstar_repository', description: 'Unstar a repository.', inputSchema: { type: 'object', properties: { repo: str }, required: ['repo'] } },
  { name: 'send_email', description: 'Email someone.', inputSchema: { type: 'object', properties: { to: str, body: str }, required: ['to', 'body'] } },
  { name: 'create_or_update_file', description: 'Write a file.', inputSchema: { type: 'object', properties: { repo: str, path: str, content: str }, required: ['repo', 'path', 'content'] } },
];

export function createIssuesServer() {
  const state = { issues: new Map<number, Issue>(), starred: new Set<string>(), emails: [] as Array<{ to: string; body: string }>, files: new Map<string, string>(), next: 1 };
  const server = new Server({ name: 'issues', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: 'Issue numbers are per repository.' });
  const text = (v: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
  const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: issueTools as never }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const a = (req.params.arguments ?? {}) as Record<string, any>;
    const issue = state.issues.get(Number(a.issue_number));
    switch (req.params.name) {
      case 'list_issues':
        return text([...state.issues.values()]);
      case 'get_issue':
        // Structured content, as newer servers send it.
        return issue ? { content: [{ type: 'text', text: JSON.stringify(issue) }], structuredContent: { ...issue } } : fail(`Issue ${a.issue_number} not found`);
      case 'create_issue': {
        if (!a.title) return fail('title is required');
        const created: Issue = { number: state.next++, title: a.title, body: a.body ?? '', state: 'open', labels: [] };
        state.issues.set(created.number, created);
        return text(created);
      }
      case 'update_issue':
        if (!issue) return fail(`Issue ${a.issue_number} not found`);
        for (const k of ['title', 'body', 'state'] as const) if (a[k] !== undefined) (issue as any)[k] = a[k];
        return text(issue);
      case 'add_issue_labels':
        if (!issue) return fail(`Issue ${a.issue_number} not found`);
        issue.labels = [...new Set([...issue.labels, ...a.labels])];
        return text(issue.labels);
      case 'remove_issue_labels':
        if (!issue) return fail(`Issue ${a.issue_number} not found`);
        issue.labels = issue.labels.filter((l) => !a.labels.includes(l));
        return text(issue.labels);
      case 'star_repository':
        state.starred.add(a.repo);
        return text({ starred: true });
      case 'unstar_repository':
        state.starred.delete(a.repo);
        return text({ starred: false });
      case 'send_email':
        state.emails.push({ to: a.to, body: a.body });
        return text({ sent: true });
      case 'create_or_update_file':
        state.files.set(a.path, a.content);
        return text({ path: a.path });
      default:
        return fail(`Unknown tool ${req.params.name}`);
    }
  });
  return { server, state };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await createIssuesServer().server.connect(new StdioServerTransport());
}
