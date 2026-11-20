/**
 * Undo plans for the tools of an MCP server (experimental).
 *
 * An MCP server describes its tools with a name, an input schema and optional
 * annotations, not with routes, so the plans come from the tool names and
 * arguments: `create_issue` is undone by `delete_issue` (the id read from the
 * result), `update_issue` by `update_issue` with the values `get_issue` read
 * before the call, `star_repo` by `unstar_repo`, and `send_email` is gated.
 * Anything that can't be paired this way is `unknown` and needs approval,
 * until an override declares its inverse.
 */
import { ACTION_PAIRS, IRREVERSIBLE_VERBS, ONE_WAY_VERBS, SIDE_EFFECT_FREE_VERBS, SOFT_DELETE_STATES, tokenize } from '../analyze.js';
import type { Reversibility } from '../types.js';

/** The parts of an MCP tool definition the planner reads. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** When present, result bindings and snapshots are checked against it instead of guessed. */
  outputSchema?: { type?: string; properties?: Record<string, unknown> };
}

/** Where an argument of a follow-up call comes from. */
export type ArgSource =
  /** An argument of the original call. */
  | { from: 'args'; key: string }
  /** A field of the original call's result: the first of these (dotted) keys that is present; `items[].id` collects a field of every item. */
  | { from: 'result'; keys: string[] }
  /** A field of the state read before the call; `optional`: left out when the state has no value for it. */
  | { from: 'before'; key: string; optional?: boolean }
  /** A fixed value, e.g. `state: "closed"`. */
  | { value: unknown };

export interface ToolCallTemplate {
  tool: string;
  arguments: Record<string, ArgSource>;
}

export type ToolStrategy =
  | 'no-side-effects'
  | 'paired-action'
  | 'delete-created'
  | 'close-created'
  | 'restore-snapshot'
  | 'recreate-from-snapshot'
  | 'declared'
  | 'none';

export interface ToolPlan {
  tool: string;
  /** For one action of a multi-action tool: the argument that selects it and its value (issue_write { method: "update" }). */
  dispatch?: { arg: string; value: string };
  reversibility: Reversibility;
  strategy: ToolStrategy;
  /** The call that undoes this one. */
  inverse?: ToolCallTemplate;
  /** restore-snapshot: every argument the call sent, other than these identifying ones, is written back from the snapshot. */
  restoreSent?: string[];
  /** A read made before the call (restore-snapshot, recreate-from-snapshot, and paired actions with a getter). */
  snapshot?: ToolCallTemplate;
  /** Paired actions: read again after the call; if nothing changed, undo does nothing (star an already-starred repo). */
  detectNoop?: boolean;
  /** Boolean arguments that, when true, make the call replace something its undo can't restore: such calls need approval. */
  unsafeFlags?: string[];
  /** A read made before undoing, to refuse when someone changed what the call wrote. */
  check?: ToolCallTemplate;
  reasons: string[];
  caveats: string[];
}

/**
 * Overrides, keyed by tool name. Argument values are `args.<name>`,
 * `result.<path>` or `before.<path>`; anything else is a fixed value.
 *
 *   { "create_page": { "inverse": "archive_page", "arguments": { "page_id": "result.id" } },
 *     "run_workflow": { "reversibility": "irreversible", "reason": "starts a deploy" } }
 */
export type ToolOverrides = Record<
  string,
  { reversibility?: 'irreversible' | 'no-side-effects' | 'unknown'; inverse?: string; arguments?: Record<string, unknown>; reason?: string }
>;

const READ_VERBS = new Set([
  ...SIDE_EFFECT_FREE_VERBS,
  'get', 'read', 'fetch', 'find', 'describe', 'view', 'retrieve', 'inspect', 'download', 'export', 'whoami', 'show', 'browse', 'explain',
]);
const GET_VERBS = new Set(['get', 'read', 'fetch', 'retrieve', 'describe', 'view', 'show', 'inspect']);
const CREATE_VERBS = new Set(['create', 'add', 'new', 'insert', 'make', 'upload']);
const DELETE_VERBS = new Set(['delete', 'remove', 'destroy', 'erase', 'drop', 'trash']);
const UPDATE_VERBS = new Set(['update', 'edit', 'modify', 'set', 'patch', 'change', 'rename', 'replace']);
const PAIR_OF = new Map<string, string[]>();
for (const [a, b] of ACTION_PAIRS) {
  PAIR_OF.set(a, [...(PAIR_OF.get(a) ?? []), b]);
  PAIR_OF.set(b, [...(PAIR_OF.get(b) ?? []), a]);
}
/** Words a getter's name may add to the noun: get_file_contents reads a file. */
const READ_SUFFIXES = new Set(['content', 'contents', 'detail', 'details', 'info', 'data', 'metadata', 'by', 'id']);
const ALL_VERBS = new Set([...READ_VERBS, ...CREATE_VERBS, ...DELETE_VERBS, ...UPDATE_VERBS, ...PAIR_OF.keys(), ...IRREVERSIBLE_VERBS, ...ONE_WAY_VERBS]);

/** Argument pairs a move or rename can be reversed by swapping. */
const MOVE_ARGS: Array<[string, string]> = [
  ['source', 'destination'], ['from', 'to'], ['src', 'dest'], ['old_path', 'new_path'], ['oldPath', 'newPath'],
  ['old_name', 'new_name'], ['oldName', 'newName'], ['path', 'new_path'], ['path', 'newPath'], ['name', 'new_name'], ['name', 'newName'],
];

const stem = (t: string) => (t.length > 3 && t.endsWith('ies') ? t.slice(0, -3) + 'y' : t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t);

interface Named {
  tool: McpTool;
  /** The tool's name, or `name#value` for one action of a tool that takes several (issue_write#update). */
  key: string;
  /** For one action of a multi-action tool: the argument that selects it, and its value. */
  dispatch?: { arg: string; value: string };
  /** The words the plan is made from: the tool's name, or the action and the tool's noun. */
  words: string[];
  verb: string | undefined;
  /** The other words of the name, singular: create_issue_comments -> "issue comment". */
  noun: string;
  props: Set<string>;
  required: string[];
  /** The properties of the declared output, if the tool declares one. */
  out?: Record<string, unknown>;
}

/** Arguments that pick one of several actions: issue_write { method: "create" | "update" }. */
const DISPATCH_ARGS = ['method', 'action', 'operation', 'op'];
/** Words in a multi-action tool's name that say nothing about the resource: issue_write -> issue. */
const GENERIC_WORDS = new Set(['write', 'read', 'manage', 'mutate', 'tool', 'ops', 'action', 'actions', 'operation', 'operations']);

/** The values of a dispatch argument: its enum, or options listed in its description ("- 'add' - ...", "1. get - ..."). */
function dispatchValues(prop: unknown): string[] {
  const p = prop as { type?: string; enum?: unknown[]; description?: string } | undefined;
  if (!p) return [];
  if (Array.isArray(p.enum)) return p.enum.filter((v): v is string => typeof v === 'string');
  const listed = [...(p.description ?? '').matchAll(/^\s*(?:-|\*|\d+\.)\s*'?([a-z][a-z0-9_]*)'?\s+[-:]/gim)].map((m) => m[1]!);
  return [...new Set(listed)];
}

function named(tool: McpTool, key: string, words: string[], required: string[], dispatch?: Named['dispatch']): Named {
  // A write verb wins over a read verb anywhere in the name: shopping_list_add_item adds, saved_view_delete deletes.
  const write = words.findIndex((w) => ALL_VERBS.has(w) && !READ_VERBS.has(w));
  const i = write !== -1 ? write : words.findIndex((w) => ALL_VERBS.has(w));
  const verb = i === -1 ? undefined : words[i];
  const noun = words
    .filter((_, j) => j !== i)
    .map(stem)
    .join(' ');
  const props = new Set(Object.keys(tool.inputSchema.properties ?? {}));
  if (dispatch) props.delete(dispatch.arg);
  return { tool, key, dispatch, words, verb, noun, props, required: required.filter((r) => r !== dispatch?.arg), out: tool.outputSchema?.properties };
}

/** A tool, or one entry per action when one argument picks among several (GitHub's issue_write { method }). */
function parse(tool: McpTool): Named[] {
  const required = tool.inputSchema.required ?? [];
  const arg = DISPATCH_ARGS.find((a) => required.includes(a) && dispatchValues(tool.inputSchema.properties?.[a]).length >= 2);
  if (!arg) return [named(tool, tool.name, tokenize(tool.name), required)];
  const nounWords = tokenize(tool.name).filter((w) => !GENERIC_WORDS.has(w) && !ALL_VERBS.has(w));
  return dispatchValues(tool.inputSchema.properties?.[arg]).map((value) => {
    const words = [...tokenize(value), ...nounWords];
    const n = named(tool, `${tool.name}#${value}`, words, required, { arg, value });
    // An update or delete of one resource needs its id even when the schema (shared with create) can't require it: issue_number.
    if (n.verb && !CREATE_VERBS.has(n.verb) && !READ_VERBS.has(n.verb)) {
      const last = nounWords.map(stem).at(-1);
      for (const p of n.props) {
        const t = tokenize(p).map(stem);
        const id = t.at(-1) === 'id' || t.at(-1) === 'number';
        if (id && (t.length === 1 || (t.length === 2 && t[0] === last) || t.slice(0, -1).join(' ') === nounWords.map(stem).join(' ')) && !n.required.includes(p)) n.required.push(p);
      }
    }
    return n;
  });
}

/** Result fields that may hold a value an inverse needs as `name`: issue_number <- number, page_id <- id. */
export function resultKeysFor(name: string, noun: string): string[] {
  const keys = [name];
  const words = tokenize(name);
  const nounWords = new Set(noun.split(' '));
  const rest = words.filter((w) => !nounWords.has(stem(w)));
  if (rest.length && rest.length < words.length) keys.push(rest.join('_'));
  if (/(^|_)id$|Id$/.test(name) || words.at(-1) === 'id') keys.push('id');
  if (words.at(-1) === 'number') keys.push('number');
  return [...new Set(keys)];
}

const sameNoun = (a: Named, b: Named) => a.noun === b.noun && a.noun !== '';
const getterNoun = (g: Named, n: Named) =>
  sameNoun(g, n) ||
  (n.noun !== '' &&
    g.noun
      .split(' ')
      .filter((w) => !READ_SUFFIXES.has(w))
      .join(' ') === n.noun);

type SchemaLike = { type?: string; items?: { properties?: Record<string, unknown> } } | undefined;

/** Whether a result key exists in a declared output: `id`, `data.id`, or `entities[].name`. */
function inOutput(out: Record<string, unknown>, key: string): boolean {
  const [head, rest] = key.split('[].') as [string, string | undefined];
  const prop = out[head.split('.')[0]!] as SchemaLike;
  if (!prop) return false;
  return rest === undefined || (prop.type === 'array' && !!prop.items?.properties?.[rest]);
}

/** Result keys that may hold `name` for `target`; checked against the source's declared output when it has one. */
function resultCandidates(name: string, target: Named, source: Named): string[] {
  const keys = resultKeysFor(name, target.noun);
  // An array argument (entityNames, ids) can collect a field from every created item: entities[].name.
  if ((target.tool.inputSchema.properties?.[name] as SchemaLike)?.type === 'array') {
    const field = stem(tokenize(name).at(-1) ?? '');
    if (source.out) {
      for (const [k, v] of Object.entries(source.out)) if ((v as SchemaLike)?.items?.properties?.[field]) keys.push(`${k}[].${field}`);
    } else {
      keys.push(`[].${field}`);
    }
  }
  return source.out ? keys.filter((k) => inOutput(source.out!, k)) : keys;
}

/**
 * Arguments for `target`, from the original call's arguments (same name) or,
 * when `fromResult` is set, its result. Undefined when a required one can't be found.
 */
function mapArgs(source: Named, target: Named, fromResult: boolean): Record<string, ArgSource> | undefined {
  const out: Record<string, ArgSource> = {};
  for (const p of target.props) {
    // A create isn't given the id of what it creates, even when its schema (shared with update) has the field: issue_write's issue_number.
    const createdId = fromResult && !!source.verb && CREATE_VERBS.has(source.verb) && !source.required.includes(p) && namesOwnId(p, target.noun);
    if (source.props.has(p) && !createdId) out[p] = { from: 'args', key: p };
    else if (target.required.includes(p)) {
      if (!fromResult) return undefined;
      const keys = resultCandidates(p, target, source);
      if (!keys.length) return undefined; // the declared output has nothing that could be it
      out[p] = { from: 'result', keys };
    }
  }
  return out;
}

/** Whether `name` is the id of a `noun` itself (issue_number, card_id, id), not of a parent (board_id). */
function namesOwnId(name: string, noun: string): boolean {
  const words = tokenize(name).map(stem);
  if (!['id', 'number', 'uuid', 'gid'].includes(words.at(-1)!)) return false;
  const rest = words.slice(0, -1).join(' ');
  return rest === '' || rest === noun || rest === noun.split(' ').at(-1);
}

/** Whether a plan rests on guesses about results the tools don't declare. */
function guessed(source: Named, args: Record<string, ArgSource>): boolean {
  return !source.out && Object.values(args).some((a) => 'from' in a && a.from === 'result');
}
const GUESS = "guessed from names (the tool declares no output schema): if a call's result doesn't fit, that call is journaled as not undoable and later calls need approval";

/** The getter for `n`'s resource whose required arguments `n` has (so it can be called with them). */
function getterFor(n: Named, all: Named[], argsFrom: Set<string>): Named | undefined {
  return all.find((g) => g.verb && GET_VERBS.has(g.verb) && getterNoun(g, n) && g.required.length > 0 && g.required.every((r) => argsFrom.has(r)));
}

/** Whether a getter's declared output has a field for a part of the resource (get_issue -> labels for "label"). */
function showsPart(g: Named, part: string): boolean {
  return !!g.out && Object.keys(g.out).some((k) => stem(tokenize(k).at(-1) ?? '') === part.split(' ').at(-1));
}

function stateValue(prop: unknown): string | undefined {
  const values = (prop as { enum?: unknown[] } | undefined)?.enum;
  return values?.find((v): v is string => typeof v === 'string' && SOFT_DELETE_STATES.includes(v));
}

function planOne(n: Named, all: Named[], override?: ToolOverrides[string]): ToolPlan {
  const plan = (p: Omit<ToolPlan, 'tool' | 'caveats'> & { caveats?: string[] }): ToolPlan => ({ tool: n.tool.name, ...(n.dispatch ? { dispatch: n.dispatch } : {}), caveats: [], ...p });
  const others = all.filter((o) => o !== n);
  const find = (verbs: Set<string> | string[], match = sameNoun) => others.find((o) => o.verb && (verbs instanceof Set ? verbs.has(o.verb) : verbs.includes(o.verb)) && match(o, n));

  if (override) {
    if (override.reversibility) {
      const reasons = [override.reason ?? 'declared in overrides'];
      if (override.reversibility === 'no-side-effects') return plan({ reversibility: 'reversible', strategy: 'no-side-effects', reasons });
      return plan({ reversibility: override.reversibility, strategy: 'none', reasons });
    }
    if (override.inverse) {
      const args: Record<string, ArgSource> = {};
      for (const [k, v] of Object.entries(override.arguments ?? {})) {
        const m = typeof v === 'string' ? /^(args|result|before)\.(.+)$/.exec(v) : null;
        args[k] = !m ? { value: v } : m[1] === 'result' ? { from: 'result', keys: [m[2]!] } : { from: m[1] as 'args' | 'before', key: m[2]! };
      }
      return plan({ reversibility: 'reversible', strategy: 'declared', inverse: { tool: override.inverse, arguments: args }, reasons: [override.reason ?? `declared: undone by ${override.inverse}`] });
    }
  }

  const words = n.words.map(stem);
  const annotations = n.tool.annotations ?? {};
  // The server's own read-only flag is trusted; names are checked for writes before they're taken for reads.
  if (annotations.readOnlyHint === true) return plan({ reversibility: 'reversible', strategy: 'no-side-effects', reasons: ['the server marks it read-only'] });
  const irreversible = words.find((w) => IRREVERSIBLE_VERBS.has(w));
  if (irreversible) {
    return plan({ reversibility: 'irreversible', strategy: 'none', reasons: [`"${irreversible}" has effects that can't be called back`] });
  }
  if (words.includes('or')) {
    return plan({ reversibility: 'unknown', strategy: 'none', reasons: [`${n.key} does one of several things, so its inverse depends on what happened; declare it in overrides`] });
  }
  if (n.verb && READ_VERBS.has(n.verb) && annotations.readOnlyHint !== false && annotations.destructiveHint !== true) {
    return plan({ reversibility: 'reversible', strategy: 'no-side-effects', reasons: [`"${n.verb}" reads without changing anything`] });
  }

  // Moves and renames are undone by moving back.
  if (words.includes('move') || words.includes('rename')) {
    const swap = MOVE_ARGS.find(([a, b]) => n.props.has(a) && n.props.has(b));
    if (swap) {
      const [a, b] = swap;
      return plan({
        reversibility: 'reversible',
        strategy: 'paired-action',
        inverse: { tool: n.key, arguments: { ...Object.fromEntries([...n.props].map((p) => [p, { from: 'args', key: p } as ArgSource])), [a]: { from: 'args', key: b }, [b]: { from: 'args', key: a } } },
        reasons: [`${n.key} back from ${b} to ${a}`],
        caveats: [`fails if something has been put at ${a} since`],
      });
    }
  }

  // Paired actions: star/unstar, lock/unlock, add/remove (same arguments).
  for (const counterpart of PAIR_OF.get(n.verb ?? '') ?? []) {
    const other = find([counterpart]);
    const args = other && mapArgs(n, other, false);
    if (other && args) {
      // A getter for the resource (or the one it belongs to: add_issue_labels -> get_issue) shows whether the call changed anything.
      const getter = others.find(
        (g) =>
          g.verb &&
          GET_VERBS.has(g.verb) &&
          g.noun !== '' &&
          (getterNoun(g, n) || (n.noun.startsWith(`${g.noun} `) && showsPart(g, n.noun.slice(g.noun.length + 1)))) &&
          g.required.length > 0 &&
          g.required.every((r) => n.props.has(r)),
      );
      return plan({
        reversibility: 'reversible',
        strategy: 'paired-action',
        inverse: { tool: other.key, arguments: args },
        ...(getter ? { snapshot: { tool: getter.key, arguments: Object.fromEntries(getter.required.map((r) => [r, { from: 'args', key: r } as ArgSource])) }, detectNoop: true } : {}),
        reasons: [`${counterpart} reverses ${n.verb}`],
        caveats: [getter ? `if ${getter.key} shows the call changed nothing, undo does nothing` : `undo calls ${other.key} even if this call changed nothing`],
      });
    }
  }

  const argNames = n.props;
  if (n.verb && CREATE_VERBS.has(n.verb)) {
    const del = find(DELETE_VERBS);
    const args = del && mapArgs(n, del, true);
    if (del && args) {
      return plan({
        reversibility: 'reversible',
        strategy: 'delete-created',
        inverse: { tool: del.key, arguments: args },
        check: checkFor(n, all, args),
        reasons: [`${del.key} deletes what it creates`],
        caveats: guessed(n, args) ? [GUESS] : [],
      });
    }
    const close = find(['close', 'archive', 'cancel', 'deactivate', 'disable']);
    const closeArgs = close && mapArgs(n, close, true);
    if (close && closeArgs) {
      return plan({
        reversibility: 'compensable',
        strategy: 'close-created',
        inverse: { tool: close.key, arguments: closeArgs },
        check: checkFor(n, all, closeArgs),
        reasons: [`${close.key} closes what it creates (there is no delete tool)`],
        caveats: ['undo closes it; it is not deleted', ...(guessed(n, closeArgs) ? [GUESS] : [])],
      });
    }
    const updater = find(UPDATE_VERBS);
    const state = updater && ['state', 'status'].find((s) => updater.props.has(s) && stateValue((updater.tool.inputSchema.properties ?? {})[s]));
    const updArgs = updater && state && mapArgs(n, { ...updater, props: new Set([...updater.required]) }, true);
    if (updater && state && updArgs) {
      const value = stateValue((updater.tool.inputSchema.properties ?? {})[state])!;
      return plan({
        reversibility: 'compensable',
        strategy: 'close-created',
        inverse: { tool: updater.key, arguments: { ...updArgs, [state]: { value } } },
        check: checkFor(n, all, updArgs),
        reasons: [`${updater.key} with ${state}: "${value}" closes what it creates (there is no delete tool)`],
        caveats: [`undo sets ${state} to "${value}"; it is not deleted`, ...(guessed(n, updArgs) ? [GUESS] : [])],
      });
    }
    return plan({ reversibility: 'unknown', strategy: 'none', reasons: [`no tool deletes or closes the ${n.noun || 'resource'} it creates`] });
  }

  if (n.verb && UPDATE_VERBS.has(n.verb)) {
    const getter = getterFor(n, others, argNames);
    if (!getter) return plan({ reversibility: 'unknown', strategy: 'none', reasons: [`no get tool reads a ${n.noun || 'resource'} with ${n.key}'s arguments, so the old values can't be captured`] });
    const identifying = getter.required;
    const written = [...n.props].filter((p) => !identifying.includes(p));
    if (getter.out && !written.some((p) => p in getter.out!)) {
      return plan({ reversibility: 'unknown', strategy: 'none', reasons: [`${getter.key} returns none of the values ${n.key} writes (${written.join(', ')}), so they can't be restored`] });
    }
    const ids = Object.fromEntries(identifying.map((r) => [r, { from: 'args', key: r } as ArgSource]));
    return plan({
      reversibility: 'reversible',
      strategy: 'restore-snapshot',
      snapshot: { tool: getter.key, arguments: ids },
      inverse: { tool: n.key, arguments: ids },
      restoreSent: n.dispatch ? [...identifying, n.dispatch.arg] : identifying,
      check: { tool: getter.key, arguments: ids },
      reasons: [`${getter.key} reads the old values; ${n.key} writes them back`],
      caveats: getter.out ? [] : [`guessed: ${getter.key} declares no output schema, so whether it returns the values to restore is only known after a call`],
    });
  }

  if (n.verb && DELETE_VERBS.has(n.verb)) {
    const getter = getterFor(n, others, argNames);
    const create = find(CREATE_VERBS);
    const recreatable = getter && create && (!getter.out || create.required.every((p) => n.props.has(p) || p in getter.out!));
    if (getter && create && recreatable) {
      const args: Record<string, ArgSource> = {};
      // Optional fields the deleted item didn't have are left out, not required.
      for (const p of create.props) args[p] = n.props.has(p) ? { from: 'args', key: p } : { from: 'before', key: p, optional: !create.required.includes(p) };
      return plan({
        reversibility: 'compensable',
        strategy: 'recreate-from-snapshot',
        snapshot: { tool: getter.key, arguments: Object.fromEntries(getter.required.map((r) => [r, { from: 'args', key: r } as ArgSource])) },
        inverse: { tool: create.key, arguments: args },
        reasons: [`${getter.key} reads it first; ${create.key} re-creates it`],
        caveats: ['re-created under a new id; what only the server kept (comments, history) is not restored'],
      });
    }
    return plan({ reversibility: 'irreversible', strategy: 'none', reasons: [`nothing can bring back a deleted ${n.noun || 'resource'}`] });
  }

  const oneWay = words.find((w) => ONE_WAY_VERBS.has(w));
  if (oneWay) return plan({ reversibility: 'irreversible', strategy: 'none', reasons: [`"${oneWay}" has no way back here`] });
  return plan({ reversibility: 'unknown', strategy: 'none', reasons: [n.verb ? `no tool undoes "${n.verb}" for ${n.noun || 'this'}` : `can't tell what ${n.key} changes`] });
}

/** A read of what a create made, to compare before undoing it. */
function checkFor(n: Named, all: Named[], inverseArgs: Record<string, ArgSource>): ToolCallTemplate | undefined {
  const available = new Set([...n.props, ...Object.keys(inverseArgs)]);
  const getter = getterFor(n, all, available);
  if (!getter) return undefined;
  // Where the inverse knows a value (a created id from the result), the read uses the same.
  return { tool: getter.key, arguments: Object.fromEntries(getter.required.map((r) => [r, inverseArgs[r] ?? ({ from: 'args', key: r } as ArgSource)])) };
}

/** Plan every tool of an MCP server. */
export function planTools(tools: McpTool[], overrides: ToolOverrides = {}): ToolPlan[] {
  const all = tools.flatMap(parse);
  const byKey = new Map(all.map((n) => [n.key, n]));
  // Templates name actions by key (issue_write#update): turn that into the tool and its fixed dispatch argument.
  const resolveKey = (t: ToolCallTemplate | undefined): ToolCallTemplate | undefined => {
    const target = t && byKey.get(t.tool);
    if (!t || !target?.dispatch) return t;
    return { tool: target.tool.name, arguments: { [target.dispatch.arg]: { value: target.dispatch.value }, ...t.arguments } };
  };
  // Reasons and caveats name actions as people and agents call them: sub_issue_write {method: "remove"}, not the internal key.
  const readable = (text: string) =>
    text.replace(/\b([\w.-]+)#([\w-]+)\b/g, (m, tool: string) => {
      const d = byKey.get(m)?.dispatch;
      return d ? `${tool} {${d.arg}: "${d.value}"}` : m;
    });
  return all.map((n) => {
    const p = planOne(n, all, overrides[n.key] ?? overrides[n.tool.name]);
    return {
      ...p,
      reasons: p.reasons.map(readable),
      caveats: p.caveats.map(readable),
      inverse: resolveKey(p.inverse),
      snapshot: resolveKey(p.snapshot),
      check: resolveKey(p.check),
      ...unsafe(n),
    };
  });
}

/** Boolean arguments that make the call replace or override something its undo can't put back (replace_parent, overwrite, force). */
function unsafe(n: Named): Pick<ToolPlan, 'unsafeFlags'> {
  const flags = [...n.props].filter((p) => /^(replace|overwrite|force)/i.test(p) && (n.tool.inputSchema.properties?.[p] as { type?: string } | undefined)?.type === 'boolean');
  return flags.length ? { unsafeFlags: flags } : {};
}

/** The plan for a call: by tool name, and for multi-action tools by the action its arguments pick. */
export function planKey(plan: Pick<ToolPlan, 'tool' | 'dispatch'>): string {
  return plan.dispatch ? `${plan.tool}#${plan.dispatch.value}` : plan.tool;
}

/** One line for a tool description and the journal: what undo does. */
export function describePlan(plan: ToolPlan): string {
  switch (plan.reversibility) {
    case 'irreversible':
      return `IRREVERSIBLE: ${plan.reasons[0]}. Needs a human's approval.`;
    case 'unknown':
      return `Cannot be undone automatically (${plan.reasons[0]}). Needs a human's approval.`;
    default:
      if (plan.strategy === 'no-side-effects') return 'Read-only.';
      return `Can be undone with undogen_undo: ${plan.reasons[0]}${plan.caveats.length ? ` (${plan.caveats.join('; ')})` : ''}.`;
  }
}
