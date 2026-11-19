import type { HttpResult, JournalEntry, UndoableClient, UndoOptions } from './runtime.js';
import type { InversePlan, Operation, Schema } from './types.js';

/** Hints about a tool's behaviour, in the shape MCP tool annotations use. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * A framework-neutral tool: a name, a JSON Schema for its input, and an
 * execute function. Adapt it to any agent framework:
 *
 *   // Vercel AI SDK
 *   tool({ description: t.description, inputSchema: jsonSchema(t.inputSchema), execute: t.execute })
 *   // OpenAI function calling
 *   { type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  annotations: ToolAnnotations;
  /** The operation this tool calls, or undefined for the undo/journal tools. */
  operationId?: string;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

export interface ToolOptions {
  /** operationIds to expose; a trailing * matches a prefix ("issues/*"). Default: all. */
  only?: string[];
  /** Include GET operations. Default true. */
  includeReads?: boolean;
  /** Add undogen_undo, undogen_undo_all and undogen_journal. Default true. */
  undoTools?: boolean;
}

/** Tool names must match ^[a-zA-Z0-9_-]{1,64}$ for most agent frameworks. */
export function toolName(operationId: string, taken: Set<string>): string {
  let base = operationId.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'op';
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 60 - String(i).length)}_${i}`;
  taken.add(name);
  return name;
}

export function matchesOnly(id: string, only: string[] | undefined): boolean {
  if (!only?.length) return true;
  return only.some((pattern) => (pattern.endsWith('*') ? id.startsWith(pattern.slice(0, -1)) : id === pattern));
}

/** Describe what undo can do for an operation, so the agent knows before it calls. */
export function undoNote(plan: InversePlan | undefined, op: Operation): string {
  if (op.method === 'get') return 'Read-only.';
  if (!plan) return 'No undo plan.';
  switch (plan.reversibility) {
    case 'reversible':
      return plan.inverse ? `Undoable: undogen_undo runs ${plan.inverse.operationId}.` : 'Undoable: changes nothing.';
    case 'compensable':
      return `Undoable as a compensation (${plan.caveats[0] ?? 'ids may change'}).`;
    case 'irreversible':
      return `IRREVERSIBLE: ${plan.reasons[0] ?? 'cannot be undone'}. Requires approval.`;
    default:
      return 'Undo unknown: requires approval.';
  }
}

/** Strip undogen's internal schema annotations before handing a schema to an agent. */
function cleanSchema(schema: Schema | undefined): unknown {
  if (!schema) return { type: 'object' };
  return JSON.parse(JSON.stringify(schema, (k, v) => (k === 'x-undogen-variants' ? undefined : v)));
}

function inputSchemaFor(op: Operation): ToolDefinition['inputSchema'] {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of op.pathParams) {
    properties[p] = { type: ['string', 'number'], description: `Path parameter {${p}}` };
    required.push(p);
  }
  if (op.queryParams.length) {
    properties.query = {
      type: 'object',
      properties: Object.fromEntries(op.queryParams.map((q) => [q.name, q.schema ?? { type: 'string' }])),
      required: op.queryParams.filter((q) => q.required).map((q) => q.name),
    };
    if (op.queryParams.some((q) => q.required)) required.push('query');
  }
  if (op.method !== 'get' && (op.requestSchema || op.requestExample !== undefined)) {
    properties.body = cleanSchema(op.requestSchema);
    required.push('body');
  }
  return { type: 'object', properties, required };
}

/** Summarise a journal entry for an agent: what ran and what undo would do. */
export function describeEntry(e: JournalEntry) {
  return {
    seq: e.seq,
    operationId: e.operationId,
    request: `${e.request.method.toUpperCase()} ${e.request.path}`,
    status: e.status,
    reversibility: e.plan.reversibility,
    undo: e.inverse ? `${e.inverse.method.toUpperCase()} ${e.inverse.path}` : e.plan.strategy === 'no-side-effects' ? 'nothing to undo' : null,
    ...(e.undoError ? { undoError: e.undoError } : {}),
    ...(e.undoWarnings?.length ? { undoWarnings: e.undoWarnings } : {}),
  };
}

function result(res: HttpResult & { entry?: JournalEntry }) {
  return { status: res.status, data: res.data, ...(res.entry ? { journal: describeEntry(res.entry) } : {}) };
}

/** One tool per API operation, plus undo and journal tools, all backed by an UndoableClient. */
export function toolDefinitions(client: UndoableClient, operations: Operation[], options: ToolOptions = {}): ToolDefinition[] {
  const taken = new Set<string>(['undogen_undo', 'undogen_undo_all', 'undogen_journal']);
  const tools: ToolDefinition[] = [];
  for (const op of operations) {
    if (op.method === 'get' && options.includeReads === false) continue;
    if (!matchesOnly(op.id, options.only)) continue;
    const plan = client.planFor(op.id);
    const reversible = op.method === 'get' || plan?.reversibility === 'reversible';
    tools.push({
      name: toolName(op.id, taken),
      operationId: op.id,
      description: [op.summary ?? `${op.method.toUpperCase()} ${op.path}`, undoNote(plan, op)].join(' '),
      inputSchema: inputSchemaFor(op),
      annotations: {
        title: op.summary ?? op.id,
        readOnlyHint: op.method === 'get',
        destructiveHint: !reversible,
        idempotentHint: op.method === 'get' || op.method === 'put' || op.method === 'delete',
        openWorldHint: true,
      },
      async execute(args) {
        const params: Record<string, string | number> = {};
        for (const p of op.pathParams) params[p] = args[p] as string | number;
        return result(
          await client.call(op.id, {
            params,
            query: args.query as Record<string, string | number | boolean> | undefined,
            body: args.body,
          }),
        );
      },
    });
  }
  if (options.undoTools === false) return tools;

  const undoOptions = (args: Record<string, unknown>): UndoOptions => ({ force: args.force === true, cascade: args.cascade === true });
  tools.push(
    {
      name: 'undogen_undo',
      description:
        'Undo one earlier write (default: the most recent one not yet undone). Refuses if someone else changed the data since, ' +
        'unless force is true, and refuses to orphan later writes that depend on it, unless cascade is true.',
      inputSchema: {
        type: 'object',
        properties: {
          seq: { type: 'integer', description: 'Journal sequence number from undogen_journal' },
          force: { type: 'boolean', description: "Overwrite someone else's later change" },
          cascade: { type: 'boolean', description: 'Also undo later writes that depend on this one' },
        },
      },
      annotations: { title: 'Undo a write', destructiveHint: true, idempotentHint: false, openWorldHint: true },
      async execute(args) {
        const seq = typeof args.seq === 'number' ? args.seq : undefined;
        const entry = seq !== undefined ? client.journal.find((e) => e.seq === seq) : [...client.journal].reverse().find((e) => e.status !== 'undone');
        const res = await client.undo(entry ?? seq, undoOptions(args));
        return { status: res.status, ...(entry ? { journal: describeEntry(entry) } : {}) };
      },
    },
    {
      name: 'undogen_undo_all',
      description: 'Roll back every write in this session, newest first (a saga rollback). Reports what could not be undone.',
      inputSchema: { type: 'object', properties: { force: { type: 'boolean' } } },
      annotations: { title: 'Undo all writes', destructiveHint: true, idempotentHint: true, openWorldHint: true },
      async execute(args) {
        const { undone, failed } = await client.undoAll({ force: args.force === true });
        return { undone: undone.map(describeEntry), failed: failed.map((f) => ({ ...describeEntry(f.entry), error: f.error.message })) };
      },
    },
    {
      name: 'undogen_journal',
      description: 'List the writes made so far, whether each can be undone, and how.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { title: 'Journal', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      async execute() {
        return { entries: client.journal.map(describeEntry) };
      },
    },
  );
  return tools;
}
