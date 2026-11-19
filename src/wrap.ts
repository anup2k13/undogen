import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { IRREVERSIBLE_VERBS, SOFT_DELETE_STATES, stems, tokenize } from './analyze.js';
import { DEFAULT_IGNORED_FIELDS, diffValues, type StateDiff } from './diff.js';
import { appendJournalEvent } from './journal.js';
import type { Reversibility } from './types.js';
import { VERSION } from './version.js';

/*
 * `undogen wrap` puts journaling and undo in front of any existing MCP server.
 * There is no OpenAPI spec, so plans are inferred from tool names, input
 * schemas and annotations (create_x <-> delete_x, update_x + get_x, ...),
 * and can be declared in a config file where names don't tell.
 */

const READ_VERBS = new Set(['get', 'list', 'read', 'search', 'fetch', 'find', 'query', 'describe', 'show', 'view', 'lookup', 'check', 'count', 'download', 'export', 'browse', 'retrieve']);
const CREATE_VERBS = ['create', 'add', 'new', 'insert', 'make'];
const DELETE_VERBS = ['delete', 'remove', 'destroy', 'drop', 'trash'];
const UPDATE_VERBS = ['update', 'edit', 'modify', 'patch', 'set', 'rename', 'change', 'replace'];
const GET_VERBS = ['get', 'read', 'fetch', 'retrieve', 'describe', 'view', 'show'];

/** A value source: "request.x", "response.x", "before.x" (dotted paths), or a literal. */
export type ArgSource = string | { literal: unknown };

export interface ToolDeclaration {
  reversibility?: Reversibility;
  reason?: string;
  /** Tool that undoes this one. */
  inverse?: string;
  /** Arguments for the inverse tool. Strings like "response.id" are looked up; other values are literals. */
  args?: Record<string, ArgSource>;
  /** Tool to read the state before the call (for restoring), with its arguments. */
  capture?: { tool: string; args: Record<string, ArgSource> };
}

export interface WrapConfig {
  tools?: Record<string, ToolDeclaration>;
}

type Kind = 'read' | 'create' | 'update' | 'delete' | 'other';

interface Ref {
  from: 'request' | 'response' | 'before';
  /** Candidate dotted keys, tried in order. */
  keys: string[];
}
type ArgPlan = Record<string, Ref | { literal: unknown }>;

export interface ToolPlan {
  tool: string;
  kind: Kind;
  reversibility: Reversibility | 'read-only';
  strategy: 'none' | 'delete-created' | 'restore-snapshot' | 'recreate-from-snapshot' | 'soft-delete' | 'declared';
  capture?: { tool: string; args: ArgPlan };
  inverse?: { tool: string; args: ArgPlan; restoreKeysSent?: boolean; restoreFields?: string[] };
  guard?: { tool: string; args: ArgPlan };
  reasons: string[];
}

export interface WrapEntry {
  seq: number;
  at: string;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  before?: unknown;
  plan: Pick<ToolPlan, 'reversibility' | 'strategy'>;
  inverse: { tool: string; args: Record<string, unknown> } | null;
  inverseError?: string;
  guard?: { tool: string; args: Record<string, unknown>; after: unknown };
  undone: boolean;
}

// ---------------------------------------------------------------------------
// Planning

function parts(name: string): { verb: string; noun: string } {
  const t = tokenize(name);
  return { verb: t[0] ?? '', noun: t.slice(1).join('_') };
}

const nounForms = (noun: string) => [...new Set([noun, ...stems(noun), noun + 's'])];

function findTool(tools: Map<string, Tool>, verbs: string[], noun: string): Tool | undefined {
  for (const n of nounForms(noun)) {
    for (const v of verbs) {
      for (const t of tools.values()) {
        const p = parts(t.name);
        if (p.verb === v && p.noun === n) return t;
      }
    }
  }
  return undefined;
}

const props = (t: Tool | undefined) => Object.keys((t?.inputSchema?.properties as Record<string, unknown>) ?? {});
const required = (t: Tool | undefined) => (t?.inputSchema?.required as string[] | undefined) ?? [];

/** For an identity parameter like issue_number or noteId, the fields a result may carry it in. */
function idCandidates(param: string): string[] {
  const last = tokenize(param).at(-1) ?? param;
  return [...new Set([param, last, 'id', 'uuid', 'key', 'name'])];
}

function kindOf(tool: Tool): Kind {
  const verb = parts(tool.name).verb;
  if (tool.annotations?.readOnlyHint === true || READ_VERBS.has(verb)) return 'read';
  if (CREATE_VERBS.includes(verb)) return 'create';
  if (DELETE_VERBS.includes(verb)) return 'delete';
  if (UPDATE_VERBS.includes(verb)) return 'update';
  return 'other';
}

function parseSource(src: ArgSource): Ref | { literal: unknown } {
  if (typeof src === 'string') {
    const m = /^(request|response|before)\.(.+)$/.exec(src);
    if (m) return { from: m[1] as Ref['from'], keys: [m[2]!] };
  }
  return typeof src === 'object' && src !== null && 'literal' in src ? src : { literal: src };
}

/** Infer how to undo each upstream tool. */
export function planTools(list: Tool[], config: WrapConfig = {}): Map<string, ToolPlan> {
  const tools = new Map(list.map((t) => [t.name, t]));
  const plans = new Map<string, ToolPlan>();

  for (const tool of list) {
    const declared = config.tools?.[tool.name];
    const { verb, noun } = parts(tool.name);
    const kind = kindOf(tool);
    const base = { tool: tool.name, kind };

    if (declared?.reversibility === 'irreversible') {
      plans.set(tool.name, { ...base, reversibility: 'irreversible', strategy: 'none', reasons: [declared.reason ?? 'Declared irreversible in config'] });
      continue;
    }
    if (declared?.inverse) {
      plans.set(tool.name, {
        ...base,
        reversibility: declared.reversibility ?? 'reversible',
        strategy: 'declared',
        capture: declared.capture
          ? { tool: declared.capture.tool, args: Object.fromEntries(Object.entries(declared.capture.args).map(([k, v]) => [k, parseSource(v)])) }
          : undefined,
        inverse: { tool: declared.inverse, args: Object.fromEntries(Object.entries(declared.args ?? {}).map(([k, v]) => [k, parseSource(v)])) },
        reasons: [declared.reason ?? `Inverse declared in config: ${declared.inverse}`],
      });
      continue;
    }
    if (kind === 'read') {
      plans.set(tool.name, { ...base, reversibility: 'read-only', strategy: 'none', reasons: ['Reads only'] });
      continue;
    }
    const tokens = tokenize(tool.name).flatMap(stems);
    const offending = [verb, ...stems(verb)].find((t) => IRREVERSIBLE_VERBS.has(t)) ?? tokens.find((t) => ['email', 'sms', 'payment', 'charge'].includes(t));
    if (offending) {
      plans.set(tool.name, { ...base, reversibility: 'irreversible', strategy: 'none', reasons: [`"${offending}" describes an effect that cannot be called back`] });
      continue;
    }

    const getter = findTool(tools, GET_VERBS, noun);
    const identityFromRequest = (t: Tool | undefined): ArgPlan =>
      Object.fromEntries(required(t).map((p) => [p, { from: 'request', keys: idCandidates(p) } as Ref]));
    const identityFromResponse = (t: Tool | undefined, createArgs: string[]): ArgPlan =>
      Object.fromEntries(
        required(t).map((p) => [p, (createArgs.includes(p) ? { from: 'request', keys: [p] } : { from: 'response', keys: idCandidates(p) }) as Ref]),
      );

    if (kind === 'create') {
      const del = findTool(tools, DELETE_VERBS, noun);
      if (del) {
        plans.set(tool.name, {
          ...base,
          reversibility: 'reversible',
          strategy: 'delete-created',
          inverse: { tool: del.name, args: identityFromResponse(del, props(tool)) },
          guard: getter ? { tool: getter.name, args: identityFromResponse(getter, props(tool)) } : undefined,
          reasons: [`${del.name} removes what ${tool.name} creates`],
        });
        continue;
      }
      const updater = findTool(tools, UPDATE_VERBS, noun);
      const stateField = ['state', 'status'].find((f) => {
        const e = (updater?.inputSchema?.properties as Record<string, { enum?: unknown[] }> | undefined)?.[f]?.enum;
        return e?.some((v) => SOFT_DELETE_STATES.includes(String(v)));
      });
      if (updater && stateField) {
        const enumValues = (updater.inputSchema.properties as Record<string, { enum: unknown[] }>)[stateField]!.enum;
        const closed = enumValues.find((v) => SOFT_DELETE_STATES.includes(String(v)));
        plans.set(tool.name, {
          ...base,
          reversibility: 'compensable',
          strategy: 'soft-delete',
          inverse: { tool: updater.name, args: { ...identityFromResponse(updater, props(tool)), [stateField]: { literal: closed } } },
          reasons: [`No delete tool; ${updater.name} can set ${stateField}="${String(closed)}"`],
        });
        continue;
      }
    }

    if (kind === 'update' && getter) {
      plans.set(tool.name, {
        ...base,
        reversibility: 'reversible',
        strategy: 'restore-snapshot',
        capture: { tool: getter.name, args: identityFromRequest(getter) },
        inverse: { tool: tool.name, args: identityFromRequest(tool), restoreKeysSent: true },
        guard: { tool: getter.name, args: identityFromRequest(getter) },
        reasons: [`Snapshot with ${getter.name}, write the old values back with ${tool.name}`],
      });
      continue;
    }

    if (kind === 'delete' && getter) {
      const creator = findTool(tools, CREATE_VERBS, noun);
      if (creator) {
        plans.set(tool.name, {
          ...base,
          reversibility: 'compensable',
          strategy: 'recreate-from-snapshot',
          capture: { tool: getter.name, args: identityFromRequest(getter) },
          inverse: {
            tool: creator.name,
            // Context args the creator needs (e.g. repo, owner) come from the delete call.
            args: Object.fromEntries(required(creator).filter((p) => props(tool).includes(p)).map((p) => [p, { from: 'request', keys: [p] } as Ref])),
            restoreFields: props(creator),
          },
          reasons: [`Snapshot with ${getter.name}, re-create with ${creator.name} (new identity)`],
        });
        continue;
      }
    }

    plans.set(tool.name, {
      ...base,
      reversibility: tool.annotations?.destructiveHint === true ? 'irreversible' : 'unknown',
      strategy: 'none',
      reasons: [tool.annotations?.destructiveHint ? 'Marked destructive by the server, and no inverse tool was found' : 'No inverse tool could be inferred; declare one in the config'],
    });
  }
  return plans;
}

// ---------------------------------------------------------------------------
// Runtime

function getPath(obj: unknown, dotted: string): unknown {
  let cur: any = obj;
  for (const k of dotted.split('.')) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Look up a value by candidate keys, at the top level or one level down ({ data: {...} }, { note: {...} }). */
function lookup(obj: unknown, keys: string[]): unknown {
  for (const k of keys) {
    const v = getPath(obj, k);
    if (v !== undefined && v !== null && typeof v !== 'object') return v;
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const nested of Object.values(obj)) {
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        for (const k of keys) {
          const v = (nested as Record<string, unknown>)[k];
          if (v !== undefined && v !== null && typeof v !== 'object') return v;
        }
      }
    }
  }
  return undefined;
}

function resolveArgs(plan: ArgPlan, sources: { request: unknown; response?: unknown; before?: unknown }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, src] of Object.entries(plan)) {
    if ('literal' in src) {
      out[name] = src.literal;
      continue;
    }
    const v = lookup(sources[src.from], src.keys);
    if (v === undefined) throw new Error(`cannot find "${name}" in the ${src.from} (tried ${src.keys.join(', ')})`);
    out[name] = v;
  }
  return out;
}

type CallResult = { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };

/** Tool results carry data as structuredContent or as JSON text. */
export function resultData(result: CallResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface WrapOptions {
  /** A connected MCP client for the upstream server. */
  upstream: Client;
  config?: WrapConfig;
  journalFile?: string;
  /** Hide tools that cannot be undone instead of exposing them with a warning. */
  hideIrreversible?: boolean;
  ignoreFields?: string[];
}

const UNDO = 'undogen_undo';
const UNDO_ALL = 'undogen_undo_all';
const JOURNAL = 'undogen_journal';

const text = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

async function listAllTools(client: Client): Promise<Tool[]> {
  const out: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    out.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/** Build an MCP server that proxies an upstream MCP server, journaling writes and offering undo. */
export async function createWrapServer(options: WrapOptions): Promise<{ server: Server; plans: Map<string, ToolPlan>; journal: WrapEntry[] }> {
  const { upstream } = options;
  const upstreamTools = await listAllTools(upstream);
  const plans = planTools(upstreamTools, options.config);
  const journal: WrapEntry[] = [];
  const ignore = new Set(options.ignoreFields ?? DEFAULT_IGNORED_FIELDS);
  let seq = 0;

  const callUpstream = async (name: string, args: Record<string, unknown>) =>
    (await upstream.callTool({ name, arguments: args })) as CallResult;

  const describeUndo = (p: ToolPlan | undefined) => {
    if (!p || p.reversibility === 'read-only') return '';
    if (p.reversibility === 'irreversible' || p.reversibility === 'unknown') return ` [undogen: ⚠ CANNOT BE UNDONE — ${p.reasons[0]}. Ask the user first.]`;
    return ` [undogen: ${p.reversibility}; ${UNDO} reverts it via ${p.inverse?.tool}.]`;
  };

  const exposed = upstreamTools.filter((t) => {
    const r = plans.get(t.name)?.reversibility;
    return !(options.hideIrreversible && (r === 'irreversible' || r === 'unknown'));
  });

  const upstreamInfo = upstream.getServerVersion();
  const server = new Server(
    { name: `undogen-wrap(${upstreamInfo?.name ?? 'upstream'})`, version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: [
        upstream.getInstructions(),
        `undogen journals every write you make through these tools. ${UNDO} reverts your latest write (or one by seq), ${UNDO_ALL} rolls back everything newest first, ${JOURNAL} lists what you changed. Undo refuses when someone else changed the data after you; only pass force: true with the user's consent.`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...exposed.map((t): Tool => {
        const p = plans.get(t.name);
        const irreversible = p?.reversibility === 'irreversible' || p?.reversibility === 'unknown';
        return {
          ...t,
          description: (t.description ?? '') + describeUndo(p),
          annotations: { ...t.annotations, ...(irreversible ? { destructiveHint: true } : {}) },
        };
      }),
      {
        name: UNDO,
        description: 'Undo your most recent write (or the write with the given seq). Refuses if someone changed the data since.',
        inputSchema: { type: 'object', properties: { seq: { type: 'number' }, force: { type: 'boolean' } } },
      },
      { name: UNDO_ALL, description: 'Roll back every write you made, newest first.', inputSchema: { type: 'object', properties: { force: { type: 'boolean' } } } },
      { name: JOURNAL, description: 'List the writes you made and how each can be undone.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    ],
  }));

  const summarize = (e: WrapEntry) => ({
    seq: e.seq,
    tool: e.tool,
    reversibility: e.plan.reversibility,
    undone: e.undone,
    undo: e.inverse ? `${e.inverse.tool} ${JSON.stringify(e.inverse.args)}` : null,
    ...(e.inverseError ? { cannotUndo: e.inverseError } : {}),
  });

  const undo = async (entry: WrapEntry, force: boolean): Promise<void> => {
    if (entry.undone) throw new Error(`#${entry.seq} is already undone`);
    if (!entry.inverse) throw new Error(`#${entry.seq} (${entry.tool}) cannot be undone: ${entry.inverseError ?? 'no inverse'}`);
    if (entry.guard && !force) {
      const live = await callUpstream(entry.guard.tool, entry.guard.args);
      if (live.isError) {
        if (entry.plan.strategy === 'delete-created') {
          entry.undone = true; // already gone
          return;
        }
        throw Object.assign(new Error(`#${entry.seq}: ${entry.guard.tool} now fails, so the data changed after your write`), { diffs: [] as StateDiff[] });
      }
      const diffs = diffValues(entry.guard.after, resultData(live), { ignore }, entry.guard.tool);
      if (diffs.length) {
        throw Object.assign(new Error(`Refusing to undo #${entry.seq} (${entry.tool}): the data changed after your write`), { diffs });
      }
    }
    const res = await callUpstream(entry.inverse.tool, entry.inverse.args);
    if (res.isError) throw new Error(`Undo of #${entry.seq} failed: ${entry.inverse.tool} returned an error: ${JSON.stringify(resultData(res))}`);
    entry.undone = true;
    if (options.journalFile) await appendJournalEvent(options.journalFile, { type: 'undo', seq: entry.seq, at: new Date().toISOString(), response: { status: 200, data: resultData(res), headers: {} } });
  };

  const undoError = (err: unknown) => {
    const e = err as Error & { diffs?: StateDiff[] };
    return text({ error: e.message, ...(e.diffs?.length ? { changedSinceYourWrite: e.diffs } : {}) }, true);
  };

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    if (name === JOURNAL) return text(journal.map(summarize));
    if (name === UNDO) {
      const target = typeof args.seq === 'number' ? journal.find((e) => e.seq === args.seq) : [...journal].reverse().find((e) => !e.undone);
      if (!target) return text('Nothing to undo', true);
      try {
        await undo(target, args.force === true);
        return text({ undone: summarize(target) });
      } catch (err) {
        return undoError(err);
      }
    }
    if (name === UNDO_ALL) {
      const undone: WrapEntry[] = [];
      const failed: Array<Record<string, unknown>> = [];
      for (const e of [...journal].reverse()) {
        if (e.undone) continue;
        try {
          await undo(e, args.force === true);
          undone.push(e);
        } catch (err) {
          failed.push({ ...summarize(e), error: (err as Error).message });
        }
      }
      return text({ undone: undone.map(summarize), failed }, failed.length > 0);
    }

    const plan = plans.get(name);
    if (!plan || plan.reversibility === 'read-only' || !exposed.some((t) => t.name === name)) {
      if (!exposed.some((t) => t.name === name)) return text(`Unknown tool: ${name}`, true);
      return callUpstream(name, args);
    }

    // Capture the state the inverse will need.
    let before: unknown;
    if (plan.capture) {
      try {
        const snap = await callUpstream(plan.capture.tool, resolveArgs(plan.capture.args, { request: args }));
        before = snap.isError ? null : resultData(snap);
      } catch {
        before = undefined;
      }
    }

    const result = await callUpstream(name, args);
    if (result.isError) return result;
    const response = resultData(result);

    let inverse: WrapEntry['inverse'] = null;
    let inverseError: string | undefined;
    if (plan.inverse) {
      try {
        const invArgs = resolveArgs(plan.inverse.args, { request: args, response, before });
        if (plan.inverse.restoreKeysSent || plan.inverse.restoreFields) {
          if (before == null || typeof before !== 'object') throw new Error('no snapshot of the previous state');
          const keys = plan.inverse.restoreKeysSent ? Object.keys(args).filter((k) => !(k in invArgs)) : plan.inverse.restoreFields!;
          for (const k of keys) if (k in (before as object) && !(k in invArgs)) invArgs[k] = (before as Record<string, unknown>)[k];
        }
        inverse = { tool: plan.inverse.tool, args: invArgs };
      } catch (err) {
        inverseError = (err as Error).message;
      }
    } else {
      inverseError = plan.reasons[0];
    }

    let guard: WrapEntry['guard'];
    if (plan.guard && inverse) {
      try {
        const gArgs = resolveArgs(plan.guard.args, { request: args, response });
        const after = await callUpstream(plan.guard.tool, gArgs);
        if (!after.isError) guard = { tool: plan.guard.tool, args: gArgs, after: resultData(after) };
      } catch {
        /* undo still works without conflict detection */
      }
    }

    const entry: WrapEntry = {
      seq: ++seq,
      at: new Date().toISOString(),
      tool: name,
      args,
      result: response,
      before,
      plan: { reversibility: plan.reversibility, strategy: plan.strategy },
      inverse,
      inverseError,
      guard,
      undone: false,
    };
    journal.push(entry);
    if (options.journalFile) {
      await appendJournalEvent(options.journalFile, {
        type: 'write',
        entry: {
          seq: entry.seq,
          at: entry.at,
          operationId: name,
          request: { operationId: name, method: 'post', path: `mcp:${name}`, body: args },
          response: { status: 200, data: response, headers: {} },
          before,
          plan: { reversibility: plan.reversibility as Reversibility, strategy: plan.strategy === 'soft-delete' ? 'soft-delete' : plan.strategy === 'declared' ? 'declared' : plan.strategy, confidence: 0.7 },
          inverse: inverse ? { operationId: inverse.tool, method: 'post', path: `mcp:${inverse.tool}`, body: inverse.args } : null,
          inverseError,
          undone: false,
        },
      });
    }

    const note = inverse
      ? `[undogen] journaled as #${entry.seq}; ${UNDO} will run ${inverse.tool} ${JSON.stringify(inverse.args)}`
      : `[undogen] journaled as #${entry.seq}; this cannot be undone (${inverseError})`;
    return { ...result, content: [...(result.content ?? []), { type: 'text', text: note }] };
  });

  return { server, plans, journal };
}

function stdioTransport(command: string, args: string[]) {
  return new StdioClientTransport({
    command,
    args,
    // Pass the full environment so the upstream server gets its tokens.
    env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>,
    stderr: 'inherit',
  });
}

/** Start an MCP server, list its tools, and return what undogen would do with each. */
export async function inspectServer(command: string, args: string[], config?: WrapConfig): Promise<ToolPlan[]> {
  const client = new Client({ name: 'undogen-wrap', version: VERSION });
  await client.connect(stdioTransport(command, args));
  try {
    return [...planTools(await listAllTools(client), config).values()];
  } finally {
    await client.close();
  }
}

/** `undogen wrap -- <command> [args...]`: proxy a stdio MCP server, adding undo. */
export async function wrapStdio(command: string, args: string[], options: Omit<WrapOptions, 'upstream'>): Promise<void> {
  const upstream = new Client({ name: 'undogen-wrap', version: VERSION });
  await upstream.connect(stdioTransport(command, args));
  const { server } = await createWrapServer({ ...options, upstream });
  const transport = new StdioServerTransport();
  transport.onclose = () => void upstream.close();
  await server.connect(transport);
}
