/**
 * `undogen wrap`: an MCP server in front of another MCP server (experimental).
 * Every tool of the wrapped server is passed through; writes are journaled
 * with the call that undoes them, irreversible and unknown calls are put to
 * the human, and undogen_undo / _undo_all / _journal / _checkpoint / _preview
 * are added.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { maskedJson } from '../mcp.js';
import type { JournalStore } from '../runtime.js';
import { VERSION } from '../version.js';
import { describePlan, planTools, type McpTool, type ToolOverrides, type ToolPlan } from './plans.js';
import { ToolConflictError, ToolDependencyError, ToolRefusedError, ToolSession, ToolUndoError, type ToolEntry } from './session.js';

export interface WrapOptions {
  /** A client already connected to the server being wrapped. */
  upstream: Client;
  overrides?: ToolOverrides;
  store?: JournalStore<ToolEntry>;
  /** How irreversible and unknown calls are approved (as in `undogen mcp`). Default 'ask'. */
  irreversible?: 'ask' | 'allow' | 'deny';
}

const UNDO_TOOLS = ['undogen_undo', 'undogen_undo_all', 'undogen_journal', 'undogen_checkpoint', 'undogen_preview'];

/** Every tool of a server, following pagination. */
export async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

function describeEntry(e: ToolEntry) {
  return {
    seq: e.seq,
    tool: e.tool,
    arguments: e.arguments,
    status: e.status,
    reversibility: e.reversibility,
    undo: e.inverse ? `${e.inverse.tool} ${maskedJson(e.inverse.arguments, 200)}` : null,
    ...(e.inverseError ? { cannotUndo: e.inverseError } : {}),
    ...(e.undoError ? { undoError: e.undoError } : {}),
    ...(e.undoWarnings?.length ? { warnings: e.undoWarnings } : {}),
  };
}

const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> });

export async function createWrapServer(options: WrapOptions): Promise<{ server: Server; session: ToolSession; plans: ToolPlan[]; tools: Tool[] }> {
  const upstreamInfo = options.upstream.getServerVersion();
  const title = upstreamInfo?.name ?? 'wrapped';
  const tools = await listAllTools(options.upstream);
  const clash = tools.find((t) => UNDO_TOOLS.includes(t.name));
  if (clash) throw new Error(`The wrapped server already has a tool named ${clash.name}`);
  const plans = planTools(tools as McpTool[], options.overrides);
  const plansOf = new Map<string, ToolPlan[]>();
  for (const p of plans) plansOf.set(p.tool, [...(plansOf.get(p.tool) ?? []), p]);
  /** One line per plan; per action for a multi-action tool. */
  const describeTool = (name: string) =>
    plansOf
      .get(name)!
      .map((p) => (p.dispatch ? `${p.dispatch.arg} "${p.dispatch.value}": ${describePlan(p)}` : describePlan(p)))
      .join('\n');
  const mode = options.irreversible ?? 'ask';

  const server = new Server(
    { name: `undogen-wrap(${title})`, version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: [
        `These are the tools of ${title}, wrapped by undogen: every write is journaled with the call that undoes it.`,
        '- Before a multi-step task, call undogen_checkpoint and keep the number; undogen_undo_all with { to: checkpoint } rolls back only that task.',
        "- Each tool's description says whether it can be undone; undogen_preview tells you before you call. IRREVERSIBLE and unknown tools need a human's approval; don't retry them after a refusal.",
        '- undogen_undo refuses when someone else changed the data since; tell the user instead of forcing it.',
        ...(upstreamInfo && options.upstream.getInstructions() ? ['', `Instructions from ${title}:`, options.upstream.getInstructions()!] : []),
      ].join('\n'),
    },
  );

  const session = await ToolSession.open({
    call: async (name, args) => (await options.upstream.callTool({ name, arguments: args })) as CallToolResult,
    plans,
    store: options.store,
    approve: async (plan, call) => {
      if (mode === 'deny') return false;
      if (mode === 'allow') return true;
      if (!server.getClientCapabilities()?.elicitation) return false;
      const res = await server.elicitInput({
        mode: 'form',
        message: `The agent wants to call ${call.tool} ${maskedJson(call.arguments)}. It is ${plan.reversibility}: ${plan.reasons[0]}. Allow it?`,
        requestedSchema: {
          type: 'object',
          properties: { approve: { type: 'boolean', title: 'Allow this call', description: 'undogen cannot undo it' } },
          required: ['approve'],
        },
      });
      return res.action === 'accept' && res.content?.approve === true;
    },
  });

  const mine = () => session.journal.filter((e) => e.session === session.session);
  const undoTools: Tool[] = [
    {
      name: 'undogen_undo',
      description:
        'Undo one of your writes in this session (default: the most recent). Refuses if someone changed the data since (force overrides), or if later writes use what it created (cascade undoes those too).',
      inputSchema: {
        type: 'object',
        properties: {
          seq: { type: 'integer', description: 'Entry number from undogen_journal' },
          force: { type: 'boolean' },
          cascade: { type: 'boolean', description: 'Also undo later writes that use what this one created' },
        },
      },
      annotations: { title: 'Undo a write', destructiveHint: true, openWorldHint: true },
    },
    {
      name: 'undogen_undo_all',
      description: 'Undo every write of this session, newest first, or only those after a checkpoint ({ to }). Reports what could not be undone.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'integer', description: 'A checkpoint from undogen_checkpoint' },
          force: { type: 'boolean' },
          cascade: { type: 'boolean', description: 'Also undo writes from other sessions that use what these created' },
        },
      },
      annotations: { title: 'Undo all', destructiveHint: true, openWorldHint: true },
    },
    {
      name: 'undogen_journal',
      description: 'List the writes made in this session and how each would be undone.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { title: 'Journal', readOnlyHint: true },
    },
    {
      name: 'undogen_checkpoint',
      description: 'Mark this point before a task; undogen_undo_all { to } later rolls back only what was done since.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { title: 'Checkpoint', readOnlyHint: true },
    },
    {
      name: 'undogen_preview',
      description: 'Before calling a tool: can it be undone, how, and does it need approval? Makes no calls. For a tool with several actions, pass the arguments you would call it with.',
      inputSchema: { type: 'object', properties: { tool: { type: 'string' }, arguments: { type: 'object' } }, required: ['tool'] },
      annotations: { title: 'Preview undo', readOnlyHint: true },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...tools.map((t) => {
        return { ...t, description: `${t.description ?? ''}${t.description ? '\n\n' : ''}${describeTool(t.name)}`.trim() };
      }),
      ...undoTools,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case 'undogen_undo': {
          const seq = typeof args.seq === 'number' ? args.seq : undefined;
          const entry = seq !== undefined ? mine().find((e) => e.seq === seq) : [...mine()].reverse().find((e) => e.status !== 'undone');
          if (!entry) {
            const other = seq !== undefined ? session.journal.find((e) => e.seq === seq) : undefined;
            throw new Error(
              other
                ? `Entry #${seq} belongs to an earlier session (${other.session}); a person can undo it with \`undogen wrap --journal <file> --undo --session ${other.session}\``
                : seq !== undefined
                  ? `No journal entry #${seq} in this session`
                  : 'Nothing to undo in this session',
            );
          }
          const undone: ToolEntry[] = [];
          await session.undo(entry, { force: args.force === true, cascade: args.cascade === true, undone });
          const also = undone.filter((e) => e !== entry);
          return json({ undone: describeEntry(entry), ...(also.length ? { alsoUndone: also.map(describeEntry) } : {}) });
        }
        case 'undogen_undo_all': {
          const { undone, failed } = await session.undoAll({
            force: args.force === true,
            cascade: args.cascade === true,
            after: typeof args.to === 'number' ? args.to : undefined,
            session: session.session,
          });
          return json({ undone: undone.map(describeEntry), failed: failed.map((f) => ({ ...describeEntry(f.entry), error: f.error.message })) });
        }
        case 'undogen_journal':
          return json({ entries: mine().map(describeEntry) });
        case 'undogen_checkpoint':
          return json({ checkpoint: session.checkpoint() });
        case 'undogen_preview': {
          if (!plansOf.has(String(args.tool))) throw new Error(`No tool named ${String(args.tool)}`);
          const plan = session.planFor(String(args.tool), (args.arguments ?? {}) as Record<string, unknown>);
          return json({
            tool: plan.tool,
            ...(plan.dispatch ? { [plan.dispatch.arg]: plan.dispatch.value } : {}),
            reversibility: plan.reversibility,
            strategy: plan.strategy,
            undo: plan.inverse?.tool ?? null,
            // Fixed arguments of the undo call: for a multi-action tool, which action undoes this one.
            ...(plan.inverse ? { undoWith: Object.fromEntries(Object.entries(plan.inverse.arguments).flatMap(([k, src]) => ('value' in src ? [[k, src.value]] : []))) } : {}),
            needsApproval: plan.reversibility === 'irreversible' || plan.reversibility === 'unknown',
            reasons: plan.reasons,
            caveats: plan.caveats,
          });
        }
      }
      if (!plansOf.has(name)) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${name}` }] };
      const { result, entry } = await session.call(name, args);
      if (!entry) return result;
      const note = entry.inverse
        ? `undogen: journaled as #${entry.seq}; undogen_undo { "seq": ${entry.seq} } undoes it with ${entry.inverse.tool}.${entry.undoWarnings?.length ? ` Note: ${entry.undoWarnings.join('; ')}.` : ''}`
        : `undogen: journaled as #${entry.seq}; it cannot be undone (${entry.inverseError ?? 'no inverse'}).`;
      return { ...result, content: [...(result.content ?? []), { type: 'text', text: note }] };
    } catch (err) {
      const e = err as Error;
      let text = e.message;
      if (err instanceof ToolRefusedError && mode === 'ask' && !server.getClientCapabilities()?.elicitation) {
        text += ' This MCP client cannot ask a human for approval, so undogen refused. Start undogen wrap with --irreversible allow to permit these calls.';
      }
      const extra =
        err instanceof ToolConflictError
          ? { entry: err.entry.seq, conflicts: err.conflicts }
          : err instanceof ToolDependencyError
            ? { entry: err.entry.seq, dependents: err.dependents.map((d) => d.seq) }
            : err instanceof ToolUndoError
              ? { entry: err.entry.seq, status: err.entry.status }
              : {};
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.name, message: text, ...extra }) }] };
    }
  });

  return { server, session, plans, tools };
}
