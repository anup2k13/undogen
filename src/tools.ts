import type { HttpResult, JournalEntry, UndoableClient, UndoOptions } from './runtime.js';
import type { InversePlan, Operation, RequestTemplate, Schema } from './types.js';

/** "DELETE /todos/{todoId} (todoId ← response.id)" */
function describeTemplate(t: RequestTemplate): string {
  const binds = Object.entries(t.bindings)
    .filter(([, r]) => r.from !== 'params')
    .map(([k, r]) => `${k} ← ${r.from === 'location' ? 'Location header' : `${r.from}.${r.key}`}`);
  const body =
    t.body?.from === 'before' ? 'body: the captured state' :
    t.body?.from === 'before-request-keys' ? 'body: the captured values of the fields sent' :
    t.body?.from === 'before-json-patch' ? 'body: a JSON Patch that puts back what the patch touched' :
    t.body?.from === 'request' ? 'body: the same request body' :
    t.body?.from === 'literal' ? `body: ${JSON.stringify(t.body.value)}` : '';
  const extra = [...binds, body].filter(Boolean).join('; ');
  return `${t.method.toUpperCase()} ${t.path}${extra ? ` (${extra})` : ''}`;
}

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
  /** Only operations with one of these OpenAPI tags. */
  tags?: string[];
  /**
   * Instead of one tool per operation (too many for large APIs), expose undogen_search,
   * undogen_describe and undogen_call, plus the undo tools.
   */
  compact?: boolean;
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
  if (op.headerParams.length) {
    properties.headers = {
      type: 'object',
      description: 'Header parameters of this operation',
      properties: Object.fromEntries(op.headerParams.map((h) => [h.name, h.schema ?? { type: 'string' }])),
      required: op.headerParams.filter((h) => h.required).map((h) => h.name),
    };
    if (op.headerParams.some((h) => h.required)) required.push('headers');
  }
  if (op.method !== 'get' && (op.requestSchema || op.requestExample !== undefined)) {
    properties.body = cleanSchema(op.requestSchema);
    required.push('body');
  }
  return { type: 'object', properties, required };
}

/**
 * Only the header parameters the operation declares: an agent must not be able to
 * replace the configured Authorization header (or set any other header) through a tool call.
 */
function declaredHeaders(op: Operation, given: unknown): Record<string, string> | undefined {
  if (!given || typeof given !== 'object') return undefined;
  const allowed = new Map(op.headerParams.map((h) => [h.name.toLowerCase(), h.name]));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(given as Record<string, unknown>)) {
    const name = allowed.get(k.toLowerCase());
    if (name && v !== undefined && v !== null) out[name] = String(v);
  }
  return Object.keys(out).length ? out : undefined;
}

const STOPWORDS = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'in', 'on', 'by', 'and', 'or', 'with', 'from', 'my', 'all', 'this', 'that', 'it', 'is', 'be', 'as', 'at', 'into', 'some', 'new']);
const stem = (w: string) => {
  let x = w.replace(/(ies)$/, 'y').replace(/(sses|ches|shes|xes)$/, (m) => m.slice(0, -2)).replace(/([^s])s$/, '$1');
  if (x.length > 4) x = x.replace(/(ing|ed)$/, '');
  if (x.length > 3) x = x.replace(/e$/, ''); // close/closed/closing -> clos
  return x;
};
const searchWords = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);

/**
 * Ranks operations for a free-text query: words are weighted by where they occur
 * (summary and name over tags, path and description) and by how rare they are (IDF),
 * with a bonus when the summary contains the whole query.
 */
function searchIndex(client: UndoableClient, tools: ToolDefinition[]): (query: string) => ToolDefinition[] {
  const docs = tools.map((t) => {
    const op = client.operation(t.operationId!)!;
    const fields: Array<[string[], number]> = [
      [searchWords(op.summary ?? ''), 3],
      [searchWords(op.id.split('/').pop() ?? op.id), 3],
      [searchWords(op.tags.join(' ')), 2],
      [searchWords(op.path.replace(/\{[^}]+\}/g, ' ')), 1],
      [searchWords((op.description ?? '').slice(0, 300)), 0.5],
    ];
    const weight = new Map<string, number>();
    for (const [ws, w] of fields) for (const x of ws) weight.set(x, Math.max(weight.get(x) ?? 0, w));
    return { t, weight, summary: (op.summary ?? '').toLowerCase(), deprecated: !!op.deprecated };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d.weight.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string) => Math.log(1 + docs.length / (df.get(w) ?? docs.length));
  return (query) => {
    const q = [...new Set(searchWords(query))];
    const phrase = query.toLowerCase().trim();
    return docs
      .map((d) => {
        let score = 0;
        for (const w of q) {
          const exact = d.weight.get(w);
          if (exact) score += exact * idf(w);
          else if (w.length >= 4) {
            const partial = [...d.weight.entries()].find(([x]) => x.startsWith(w) || (x.length >= 4 && w.startsWith(x)));
            if (partial) score += partial[1] * idf(partial[0]) * 0.5;
          }
        }
        if (phrase && d.summary.includes(phrase)) score += 10;
        return { t: d.t, score: d.deprecated ? score * 0.3 : score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.t);
  };
}

/** Three tools that reach every operation: search, describe, call. */
function compactTools(client: UndoableClient, perOperation: ToolDefinition[]): ToolDefinition[] {
  const byKey = new Map<string, ToolDefinition>();
  for (const t of perOperation) {
    byKey.set(t.name, t);
    if (t.operationId) byKey.set(t.operationId, t);
  }
  const find = (name: unknown) => {
    const t = byKey.get(String(name ?? ''));
    if (!t) throw new Error(`Unknown operation "${String(name)}". Use undogen_search to find one.`);
    return t;
  };
  const index = searchIndex(client, perOperation);
  const summary = (t: ToolDefinition) => {
    const op = client.operation(t.operationId!)!;
    return { operation: t.name, route: `${op.method.toUpperCase()} ${op.path}`, description: t.description };
  };
  return [
    {
      name: 'undogen_search',
      description: `Find API operations by what they do (${perOperation.length} available). Returns names to pass to undogen_describe and undogen_call, and whether each can be undone.`,
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What you want to do, e.g. "close an issue"' }, limit: { type: 'integer', description: 'Default 10' } },
        required: ['query'],
      },
      annotations: { title: 'Search operations', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      async execute(args) {
        const limit = typeof args.limit === 'number' ? args.limit : 10;
        return { results: index(String(args.query ?? '')).slice(0, limit).map((t) => summary(t)) };
      },
    },
    {
      name: 'undogen_describe',
      description: 'The input schema of an operation found with undogen_search, and whether it can be undone. Makes no API calls.',
      inputSchema: { type: 'object', properties: { operation: { type: 'string' } }, required: ['operation'] },
      annotations: { title: 'Describe an operation', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      async execute(args) {
        const t = find(args.operation);
        return { ...summary(t), input: t.inputSchema, annotations: t.annotations };
      },
    },
    {
      name: 'undogen_call',
      description: 'Call an operation by name with the input undogen_describe shows: { operation, input: { <path params>, query, headers, body } }. Writes are journaled and can be undone with undogen_undo.',
      inputSchema: {
        type: 'object',
        properties: { operation: { type: 'string' }, input: { type: 'object', description: 'Path parameters, plus query, headers and body as described' } },
        required: ['operation'],
      },
      annotations: { title: 'Call an operation', destructiveHint: true, openWorldHint: true },
      async execute(args) {
        return find(args.operation).execute((args.input ?? {}) as Record<string, unknown>);
      },
    },
  ];
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
  const taken = new Set<string>(['undogen_undo', 'undogen_undo_all', 'undogen_journal', 'undogen_preview', 'undogen_checkpoint']);
  const tools: ToolDefinition[] = [];
  for (const op of operations) {
    if (op.method === 'get' && options.includeReads === false) continue;
    if (!matchesOnly(op.id, options.only)) continue;
    if (options.tags?.length && !op.tags.some((t) => options.tags!.some((w) => w.toLowerCase() === t.toLowerCase()))) continue;
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
            headers: declaredHeaders(op, args.headers),
            body: args.body,
          }),
        );
      },
    });
  }
  const perOperation = [...tools]; // undogen_preview looks names up here, compact or not
  if (options.compact) tools.splice(0, tools.length, ...compactTools(client, perOperation));
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
        await client.ready(); // a persisted journal may still be loading
        // Agents act on their own session only: a persisted journal also holds earlier sessions' writes.
        const mine = client.journal.filter((e) => e.session === client.session);
        const seq = typeof args.seq === 'number' ? args.seq : undefined;
        const entry = seq !== undefined ? mine.find((e) => e.seq === seq) : [...mine].reverse().find((e) => e.status !== 'undone');
        if (!entry) {
          throw new Error(
            seq !== undefined && client.journal.some((e) => e.seq === seq)
              ? `Entry #${seq} belongs to an earlier session; a person can undo it with \`undogen undo --journal\``
              : seq !== undefined
                ? `No journal entry #${seq} in this session`
                : 'Nothing to undo in this session',
          );
        }
        const res = await client.undo(entry, undoOptions(args));
        return { status: res.status, ...(entry ? { journal: describeEntry(entry) } : {}) };
      },
    },
    {
      name: 'undogen_undo_all',
      description:
        'Roll back every write in this session, newest first (a saga rollback), or only those made after a checkpoint from undogen_checkpoint. Reports what could not be undone.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'integer', description: 'Checkpoint from undogen_checkpoint: undo only what was done after it' },
          force: { type: 'boolean' },
        },
      },
      annotations: { title: 'Undo all writes', destructiveHint: true, idempotentHint: true, openWorldHint: true },
      async execute(args) {
        const after = typeof args.to === 'number' ? args.to : undefined;
        const { undone, failed } = await client.undoAll({ force: args.force === true, after, session: client.session });
        return { undone: undone.map(describeEntry), failed: failed.map((f) => ({ ...describeEntry(f.entry), error: f.error.message })) };
      },
    },
    {
      name: 'undogen_checkpoint',
      description:
        'Mark this point before starting a task. If the task goes wrong, undogen_undo_all with { to: checkpoint } rolls back only what was done since.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { title: 'Checkpoint', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      async execute() {
        return { checkpoint: await client.checkpoint() };
      },
    },
    {
      name: 'undogen_preview',
      description:
        'Before calling a tool, ask whether its effect can be undone and how: reversibility, the undo request, what is captured first, and caveats. Makes no API calls.',
      inputSchema: {
        type: 'object',
        properties: { tool: { type: 'string', description: 'Tool name or operationId to preview' } },
        required: ['tool'],
      },
      annotations: { title: 'Preview undo', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      async execute(args) {
        const wanted = String(args.tool ?? '');
        const t = perOperation.find((x) => x.name === wanted || x.operationId === wanted);
        const op = t?.operationId ? client.operation(t.operationId) : client.operation(wanted);
        if (!op) throw new Error(`Unknown tool or operation "${wanted}"`);
        if (op.method === 'get') return { tool: t?.name ?? op.id, reversibility: 'read-only', undo: 'nothing to undo' };
        const plan = client.planFor(op.id);
        if (!plan) throw new Error(`No undo plan for ${op.id}`);
        const describe = (r: RequestTemplate | undefined) => (r ? describeTemplate(r) : undefined);
        return {
          tool: t?.name ?? op.id,
          operation: `${op.method.toUpperCase()} ${op.path}`,
          reversibility: plan.reversibility,
          strategy: plan.strategy,
          confidence: plan.confidence,
          needsApproval: plan.reversibility === 'irreversible' || plan.reversibility === 'unknown',
          capture: describe(plan.capture),
          undo: describe(plan.inverse) ?? (plan.strategy === 'no-side-effects' ? 'nothing to undo' : null),
          ...(plan.inverseIfMissing ? { undoIfNew: describe(plan.inverseIfMissing) } : {}),
          reasons: plan.reasons,
          caveats: plan.caveats,
        };
      },
    },
    {
      name: 'undogen_journal',
      description: 'List the writes made in this session, whether each can be undone, and how.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { title: 'Journal', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      async execute() {
        await client.ready();
        return { entries: client.journal.filter((e) => e.session === client.session).map(describeEntry) };
      },
    },
  );
  return tools;
}
