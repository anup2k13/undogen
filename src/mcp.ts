import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { IrreversibleOperationError, UndoableClient, UndoError, type ClientOptions, type IrreversibleContext } from './runtime.js';
import { toolDefinitions, type ToolOptions } from './tools.js';
import type { InversePlan, Operation } from './types.js';
import { VERSION } from './version.js';

export interface McpServerOptions extends Omit<ClientOptions, 'allowIrreversible'>, ToolOptions {
  /**
   * How irreversible (and unknown) calls are approved:
   * - 'ask' (default): ask the human through MCP elicitation; refuse if the client can't ask
   * - 'allow': allow, except exact repeats of an earlier irreversible call, which are still asked about
   * - 'deny': always refuse
   */
  irreversible?: 'ask' | 'allow' | 'deny';
}

/**
 * An MCP server that exposes an OpenAPI-described API as tools, journals every
 * write with its inverse, and adds undo tools. Connect it to any transport,
 * e.g. `await server.connect(new StdioServerTransport())`.
 */
export async function createMcpServer(options: McpServerOptions): Promise<{ server: Server; client: UndoableClient }> {
  const mode = options.irreversible ?? 'ask';
  const server = new Server({ name: 'undogen', version: VERSION }, { capabilities: { tools: {} } });

  const approve = async (op: Operation, plan: InversePlan, _input: unknown, ctx: IrreversibleContext): Promise<boolean> => {
    if (mode === 'deny') return false;
    if (mode === 'allow' && !ctx.replayOf) return true;
    if (!server.getClientCapabilities()?.elicitation) return false;
    const reason = plan.reasons[0] ?? 'it cannot be undone';
    const replay = ctx.replayOf ? ` An identical call already ran as #${ctx.replayOf.seq} at ${ctx.replayOf.at}; this would do it again.` : '';
    const res = await server.elicitInput({
      mode: 'form',
      message: `The agent wants to call ${op.id} (${op.method.toUpperCase()} ${op.path}). It is ${plan.reversibility}: ${reason}.${replay} Allow it?`,
      requestedSchema: {
        type: 'object',
        properties: { approve: { type: 'boolean', title: 'Allow this call', description: 'It cannot be undone' } },
        required: ['approve'],
      },
    });
    return res.action === 'accept' && res.content?.approve === true;
  };

  const client = await UndoableClient.open({ ...options, allowIrreversible: approve, allowReplays: false });
  const tools = toolDefinitions(client, options.spec.operations, options);
  const byName = new Map(tools.map((t) => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const tool = byName.get(req.params.name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${req.params.name}` }] };
    try {
      const out = await tool.execute((req.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out as Record<string, unknown> };
    } catch (err) {
      const e = err as Error;
      let text = e.message;
      if (err instanceof IrreversibleOperationError && mode === 'ask' && !server.getClientCapabilities()?.elicitation) {
        text += ' This MCP client cannot ask a human for approval, so undogen refused. Start the server with --irreversible allow to permit these calls.';
      }
      const extra = err instanceof UndoError ? { entry: err.entry.seq, status: err.entry.status } : {};
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.name, message: text, ...extra }) }] };
    }
  });

  return { server, client };
}
