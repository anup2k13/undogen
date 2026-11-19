import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { analyze } from './analyze.js';
import { UndoableClient, UndoConflictError, type JournalEntry } from './runtime.js';
import type { ApiSpec, InversePlan, Operation } from './types.js';
import { VERSION } from './version.js';

export interface McpOptions {
  spec: ApiSpec;
  baseUrl: string;
  plans?: InversePlan[];
  headers?: Record<string, string>;
  journalFile?: string;
  /**
   * Expose operations undogen classifies as irreversible or unknown.
   * Off by default: the agent never sees them. When on, they are marked
   * destructive so MCP clients ask the user before running them.
   */
  allowIrreversible?: boolean;
  fetch?: typeof fetch;
}

const UNDO = 'undogen_undo';
const UNDO_ALL = 'undogen_undo_all';
const JOURNAL = 'undogen_journal';

const INSTRUCTIONS = `Every write you make through this server is journaled together with the exact request that reverses it.
- Call ${UNDO} to revert your most recent write (or a specific one by seq), and ${UNDO_ALL} to roll back everything you did, newest first.
- Call ${JOURNAL} to see what you have changed and what can still be undone.
- Undo refuses if someone else changed the resource after your write, and reports what changed. Only pass force: true if the user agrees to overwrite their change.
- Each tool's description says whether its effect can be undone.`;

/** MCP tool names must match ^[a-zA-Z0-9_-]{1,64}$. */
function toolNames(ops: Operation[]): Map<string, Operation> {
  const byName = new Map<string, Operation>();
  for (const op of ops) {
    const base = op.id.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'op';
    let name = base;
    for (let i = 2; byName.has(name); i++) name = `${base.slice(0, 60)}_${i}`;
    byName.set(name, op);
  }
  return byName;
}

function describe(op: Operation, plan: InversePlan | undefined): string {
  const what = op.summary ? `${op.summary} ` : '';
  const route = `(${op.method.toUpperCase()} ${op.path})`;
  if (op.method === 'get') return `${what}${route}. Read-only.`;
  if (!plan) return `${what}${route}.`;
  const how: Record<string, string> = {
    'delete-created': 'Undo deletes what this creates.',
    'restore-snapshot': 'Undo restores the previous values.',
    'recreate-from-snapshot': 'Undo re-creates it from a snapshot, under a new id; children deleted with it are not restored.',
    'soft-delete': 'Undo closes/archives what this creates; it cannot be fully removed.',
    'paired-action': 'Undo runs the opposite action.',
    toggle: 'Undo runs the opposite action.',
    'no-side-effects': 'Changes nothing.',
    declared: 'Undo is declared by the API owner.',
  };
  if (plan.reversibility === 'irreversible' || plan.reversibility === 'unknown') {
    return `${what}${route}. ⚠ CANNOT BE UNDONE (${plan.reasons[0] ?? plan.reversibility}). Ask the user before calling.`;
  }
  return `${what}${route}. ${plan.reversibility === 'compensable' ? 'Compensable' : 'Reversible'}: ${how[plan.strategy] ?? ''}`.trim();
}

function inputSchema(op: Operation): Tool['inputSchema'] {
  const properties: Record<string, object> = {};
  for (const p of op.pathParams) properties[p] = { type: ['string', 'number'], description: `Path parameter {${p}}` };
  properties.query = { type: 'object', description: 'Query string parameters', additionalProperties: true };
  if (op.requestSchema || op.requestExample !== undefined) {
    properties.body = { ...(op.requestSchema ?? { type: 'object' }), description: 'JSON request body' };
  }
  return { type: 'object', properties, required: [...op.pathParams, ...(op.requestRequired || op.requestSchema?.required?.length ? ['body'] : [])] };
}

function summarize(e: JournalEntry) {
  return {
    seq: e.seq,
    at: e.at,
    operation: e.operationId,
    request: `${e.request.method.toUpperCase()} ${e.request.path}`,
    reversibility: e.plan.reversibility,
    undone: e.undone,
    undo: e.inverse ? `${e.inverse.method.toUpperCase()} ${e.inverse.path}` : e.plan.strategy === 'no-side-effects' ? 'nothing to undo' : null,
    ...(e.inverseError && !e.inverse ? { cannotUndo: e.inverseError } : {}),
  };
}

const text = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/** Build an MCP server that exposes an OpenAPI API as tools, with every write journaled and undoable. */
export async function createMcpServer(options: McpOptions): Promise<{ server: Server; client: UndoableClient }> {
  const plans = options.plans ?? analyze(options.spec).plans;
  const planById = new Map(plans.map((p) => [p.operationId, p]));
  const client = await UndoableClient.open({
    spec: options.spec,
    baseUrl: options.baseUrl,
    plans,
    headers: options.headers,
    journalFile: options.journalFile,
    fetch: options.fetch,
    // Exposure is the gate: when irreversible tools are exposed, the client's own approval UI applies.
    allowIrreversible: !!options.allowIrreversible,
  });

  const exposed = options.spec.operations.filter((op) => {
    const r = planById.get(op.id)?.reversibility;
    return options.allowIrreversible || op.method === 'get' || (r !== 'irreversible' && r !== 'unknown');
  });
  const tools = toolNames(exposed);

  const server = new Server({ name: 'undogen', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...[...tools].map(([name, op]): Tool => {
        const plan = planById.get(op.id);
        const irreversible = plan?.reversibility === 'irreversible' || plan?.reversibility === 'unknown';
        return {
          name,
          description: describe(op, plan),
          inputSchema: inputSchema(op),
          annotations: {
            title: op.summary ?? op.id,
            readOnlyHint: op.method === 'get' || plan?.strategy === 'no-side-effects',
            destructiveHint: op.method !== 'get' && irreversible,
            openWorldHint: true,
          },
        };
      }),
      {
        name: UNDO,
        description: 'Undo your most recent write (or the write with the given seq). Refuses if someone changed the resource since.',
        inputSchema: {
          type: 'object',
          properties: {
            seq: { type: 'number', description: 'Journal entry to undo (default: most recent not yet undone)' },
            force: { type: 'boolean', description: "Overwrite changes other people made after your write. Only with the user's consent." },
          },
        },
        annotations: { title: 'Undo last write', destructiveHint: false },
      },
      {
        name: UNDO_ALL,
        description: 'Roll back every write you made, newest first. Reports anything that could not be undone.',
        inputSchema: { type: 'object', properties: { force: { type: 'boolean' } } },
        annotations: { title: 'Undo all writes', destructiveHint: false },
      },
      {
        name: JOURNAL,
        description: 'List the writes you have made, whether each can be undone, and how.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { title: 'Show journal', readOnlyHint: true },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (req.params.name === JOURNAL) return text(client.journal.map(summarize));

      if (req.params.name === UNDO) {
        const seq = typeof args.seq === 'number' ? args.seq : undefined;
        const res = await client.undo(seq, { force: args.force === true });
        const entry = seq !== undefined ? client.journal.find((e) => e.seq === seq)! : [...client.journal].reverse().find((e) => e.undone)!;
        return text({ undone: summarize(entry), status: res.status });
      }

      if (req.params.name === UNDO_ALL) {
        const { undone, failed } = await client.undoAll({ force: args.force === true });
        return text(
          { undone: undone.map(summarize), failed: failed.map(({ entry, error }) => ({ ...summarize(entry), error: error.message })) },
          failed.length > 0,
        );
      }

      const op = tools.get(req.params.name);
      if (!op) return text(`Unknown tool: ${req.params.name}`, true);
      const params: Record<string, string | number> = {};
      for (const p of op.pathParams) params[p] = args[p] as string | number;
      const res = await client.call(op.id, {
        params,
        query: args.query as Record<string, string | number | boolean> | undefined,
        body: args.body,
      });
      const result: Record<string, unknown> = { status: res.status, data: res.data };
      if (res.entry) result.journal = summarize(res.entry);
      return text(result, res.status >= 400);
    } catch (err) {
      if (err instanceof UndoConflictError) {
        return text({ error: err.message, changedSinceYourWrite: err.diffs }, true);
      }
      return text((err as Error).message, true);
    }
  });

  return { server, client };
}

/** Run the MCP server over stdio (what `undogen mcp` does). */
export async function serveStdio(options: McpOptions): Promise<void> {
  const { server } = await createMcpServer(options);
  await server.connect(new StdioServerTransport());
}
