import type {
  Analysis,
  ChildPlan,
  ApiSpec,
  BodyTemplate,
  Declaration,
  HttpMethod,
  InversePlan,
  Operation,
  RequestTemplate,
  Reversibility,
  Schema,
  ValueRef,
} from './types.js';
import { structuralPath } from './spec.js';

/** Action endpoints that undo each other: POST /x/{id}/archive <-> POST /x/{id}/unarchive. */
const ACTION_PAIRS: Array<[string, string]> = [
  ['archive', 'unarchive'],
  ['lock', 'unlock'],
  ['enable', 'disable'],
  ['activate', 'deactivate'],
  ['open', 'close'],
  ['reopen', 'close'],
  ['start', 'stop'],
  ['pause', 'resume'],
  ['suspend', 'resume'],
  ['publish', 'unpublish'],
  ['star', 'unstar'],
  ['follow', 'unfollow'],
  ['subscribe', 'unsubscribe'],
  ['pin', 'unpin'],
  ['hide', 'unhide'],
  ['hide', 'show'],
  ['block', 'unblock'],
  ['mute', 'unmute'],
  ['assign', 'unassign'],
  ['attach', 'detach'],
  ['add', 'remove'],
  ['freeze', 'unfreeze'],
  ['approve', 'unapprove'],
  ['like', 'unlike'],
  ['mark', 'unmark'],
  ['invite', 'kick'],
  ['join', 'leave'],
];

/** Verbs whose effects leave the system boundary or cannot be called back. */
const IRREVERSIBLE_VERBS = new Set([
  'send', 'email', 'mail', 'notify', 'sms', 'broadcast', 'charge', 'pay', 'payout',
  'transfer', 'refund', 'purge', 'wipe', 'shred', 'deliver', 'dispatch', 'execute', 'remind',
  'cancel', 'merge', 'revoke', 'rerun', 'rerequest', 'ping', 'redeliver', 'dismiss', 'trigger',
]);

/**
 * Verbs that are unambiguous wherever they appear in an operation name or summary
 * ("createAndSendInvoice", "Creates an invoice and emails it"). Nouns like "email"
 * or "merge" are left out here: "updateEmail" is not irreversible.
 */
const STRONG_IRREVERSIBLE_VERBS = new Set([
  'send', 'sends', 'sending', 'notify', 'notifies', 'notifying', 'emails', 'emailing', 'texts', 'sms',
  'broadcast', 'broadcasts', 'charge', 'charges', 'charging', 'pay', 'pays', 'payout', 'transfer', 'transfers',
  'refund', 'refunds', 'purge', 'purges', 'wipe', 'wipes', 'shred', 'deliver', 'delivers', 'dispatch',
  'dispatches', 'execute', 'executes', 'remind', 'reminds', 'redeliver', 'rerun', 'trigger', 'triggers',
]);

/** Past-tense forms that only appear in prose ("Watchers are notified"); used for description caveats. */
const PAST_TENSE_EFFECTS = new Set(['sent', 'notified', 'emailed', 'charged', 'delivered', 'triggered', 'executed', 'dispatched', 'broadcasted', 'refunded']);

/** Words that negate a following verb in a summary: "without sending", "does not notify". */
const NEGATIONS = new Set(['not', 'no', 'without', 'never', 'dont', 'doesn', 'don', 't']);

/** Verbs for POSTs that compute something and change nothing. */
const SIDE_EFFECT_FREE_VERBS = new Set([
  'render', 'preview', 'search', 'query', 'validate', 'lint', 'estimate', 'simulate', 'compare', 'diff',
  'list', 'lookup', 'check', 'count', 'calculate',
]);

/**
 * State transitions with no way back, used only when nothing else matched (so
 * approve still pairs with unapprove where the API has one): void, finalize, ...
 */
const ONE_WAY_VERBS = new Set([
  'void', 'expire', 'finalize', 'capture', 'confirm', 'submit', 'reverse', 'reject', 'decline', 'fail',
  'redact', 'complete', 'accept', 'approve', 'advance', 'migrate', 'delete', 'destroy', 'erase', 'revoke',
]);

/** Values of a state/status field that mean "this is gone" for APIs without DELETE. */
const SOFT_DELETE_STATES = ['closed', 'archived', 'cancelled', 'canceled', 'inactive', 'deleted', 'disabled', 'revoked'];

/** Crude singularisation so "dispatches"/"pings" match "dispatch"/"ping". */
const stems = (t: string) => [t, t.replace(/es$/, ''), t.replace(/s$/, '')];

const MUTATING: HttpMethod[] = ['post', 'put', 'patch', 'delete'];

const isParamSeg = (seg: string) => /^\{[^}]+\}$/.test(seg);
/** Segments of the structural path (format suffixes like .json removed). */
const segmentsOf = (path: string) => structuralPath(path).split('/').filter(Boolean);
const paramName = (seg: string) => seg.slice(1, -1);
const joinPath = (segs: string[]) => '/' + segs.join('/');

/** Split identifiers like "sendReminder", "send-reminder", "send_reminder" into lowercase words. */
export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

interface Index {
  ops: Operation[];
  find(method: HttpMethod, path: string): Operation | undefined;
  byId(id: string): Operation | undefined;
  /** The first item route directly under a collection: /todos -> /todos/{todoId}. */
  itemOf(collectionPath: string): string | undefined;
  hasItemChild(path: string): boolean;
}

function buildIndex(spec: ApiSpec): Index {
  const byKey = new Map<string, Operation>();
  const byId = new Map<string, Operation>();
  const items = new Map<string, string>(); // structural collection path -> first item route
  for (const o of spec.operations) {
    const key = `${o.method} ${structuralPath(o.path)}`;
    if (!byKey.has(key)) byKey.set(key, o);
    if (!byId.has(o.id)) byId.set(o.id, o);
    const segs = segmentsOf(o.path);
    if (segs.length && isParamSeg(segs.at(-1)!)) {
      const parent = joinPath(segs.slice(0, -1));
      if (!items.has(parent)) items.set(parent, o.path);
    }
  }
  return {
    ops: spec.operations,
    find: (method, path) => byKey.get(`${method} ${structuralPath(path)}`),
    byId: (id) => byId.get(id),
    itemOf: (path) => items.get(structuralPath(path)),
    hasItemChild: (path) => items.has(structuralPath(path)),
  };
}

/** Find the path that addresses a single item of `collectionPath`, e.g. /todos -> /todos/{todoId}. */
function itemPathOf(index: Index, collectionPath: string): string | undefined {
  return index.itemOf(collectionPath);
}

/** Bind every path param of `targetPath` to the original call's params, except `overrides`. */
function bindParams(targetPath: string, overrides: Record<string, ValueRef> = {}): Record<string, ValueRef> {
  const bindings: Record<string, ValueRef> = {};
  for (const seg of segmentsOf(targetPath)) {
    if (!isParamSeg(seg)) continue;
    const name = paramName(seg);
    bindings[name] = overrides[name] ?? { from: 'params', key: name };
  }
  return bindings;
}

/** How to write a PATCH back: JSON Patch needs an inverse patch; merge patch removes added keys with null. */
function patchBody(op: Operation): BodyTemplate {
  const type = op.requestContentType ?? '';
  if (/json-patch/i.test(type)) return { from: 'before-json-patch' };
  if (/merge-patch/i.test(type)) return { from: 'before-request-keys', nullMissing: true };
  return { from: 'before-request-keys' };
}

function writableFields(schema: Schema | undefined): string[] | '*' {
  if (!schema?.properties) return '*';
  return Object.entries(schema.properties)
    .filter(([, s]) => !s?.readOnly)
    .map(([k]) => k);
}

/** Guess which response field carries the new resource's identifier. */
function idFieldFor(param: string, response: Schema | undefined): { key: string; known: boolean; list?: boolean } {
  const type = Array.isArray(response?.type) ? response?.type[0] : response?.type;
  if (type === 'array') return { key: 'id', known: false, list: true };
  // issue_number -> number, todoId -> id: the param's last word often names the field.
  const lastWord = tokenize(param).at(-1) ?? param;
  const candidates = [param, lastWord, 'id', param.replace(/Id$/, '_id'), param.replace(/_id$/, 'Id'), 'uuid', 'key', 'name'];
  const props = response?.properties ?? {};
  for (const c of candidates) if (c in props) return { key: c, known: true };
  // One level of envelope: { data: { id } }
  for (const [envelope, s] of Object.entries(props)) {
    for (const c of candidates) if (s?.properties && c in s.properties) return { key: `${envelope}.${c}`, known: true };
  }
  return { key: 'id', known: false };
}

function plan(
  op: Operation,
  reversibility: Reversibility,
  strategy: InversePlan['strategy'],
  confidence: number,
  extra: Partial<InversePlan> = {},
): InversePlan {
  return {
    operationId: op.id,
    method: op.method,
    path: op.path,
    reversibility,
    strategy,
    confidence,
    reasons: [],
    caveats: [],
    ...extra,
  };
}

const getTemplate = (op: Operation): RequestTemplate => ({
  operationId: op.id,
  method: 'get',
  path: op.path,
  bindings: bindParams(op.path),
});

/** A PATCH on the item whose state/status enum includes a "gone" value. */
function softDeleteOf(index: Index, itemPath: string): { op: Operation; field: string; value: string } | undefined {
  const patch = index.find('patch', itemPath);
  if (!patch) return undefined;
  for (const field of ['state', 'status']) {
    const values = patch.requestSchema?.properties?.[field]?.enum;
    const value = values?.find((v): v is string => typeof v === 'string' && SOFT_DELETE_STATES.includes(v));
    if (value) return { op: patch, field, value };
  }
  return undefined;
}

/**
 * The sibling action that undoes `last`: archive <-> unarchive, and compound names
 * where the leading verb or trailing word flips (addFollowers <-> removeFollowers,
 * markRead <-> markUnread). The counterpart gets the same body when both take one.
 */
function pairedActionPlan(op: Operation, index: Index, parentPath: string, last: string): InversePlan | undefined {
  const norm = (s: string) => tokenize(s).join('');
  const words = tokenize(last);
  const candidates = new Set(counterpartsOf(last.toLowerCase()).map(norm));
  if (words.length > 1) {
    const [head, ...rest] = words as [string, ...string[]];
    for (const c of counterpartsOf(head)) candidates.add([c, ...rest].join(''));
    const tail = words.at(-1)!;
    const init = words.slice(0, -1);
    candidates.add([...init, tail.startsWith('un') ? tail.slice(2) : `un${tail}`].join(''));
  }
  candidates.delete(norm(last));
  const target = index.ops.find((o) => {
    if (o.method === 'get' || o.id === op.id) return false;
    const segs = segmentsOf(o.path);
    return joinPath(segs.slice(0, -1)) === parentPath && candidates.has(norm(segs.at(-1) ?? ''));
  });
  if (!target) return undefined;
  // Only compound names (addTag/removeTag) imply the same arguments; pause/resume take different ones.
  const acceptsBody = (o: Operation) => !!(o.requestSchema || o.requestExample !== undefined);
  const sameArgs = words.length > 1 && acceptsBody(op) && acceptsBody(target);
  // ...and only if what the counterpart requires is in our request (Stripe remove_lines needs line ids add_lines never had).
  // Both directions: add/remove of members is symmetric; remove_lines (by id) -> add_lines (by content) is not.
  if (sameArgs && !(providesRequired(op.requestSchema, target.requestSchema) && providesRequired(target.requestSchema, op.requestSchema))) return undefined;
  const theirs = target.requestSchema?.properties ? Object.keys(target.requestSchema.properties) : undefined;
  const shared = theirs && op.requestSchema?.properties ? Object.keys(op.requestSchema.properties).filter((k) => theirs.includes(k)) : undefined;
  const counterpart = segmentsOf(target.path).at(-1)!;
  return plan(op, 'reversible', 'paired-action', words.length > 1 ? 0.6 : 0.7, {
    inverse: {
      operationId: target.id,
      method: target.method,
      path: target.path,
      bindings: bindParams(target.path),
      body: sameArgs ? (shared ? { from: 'request', fields: shared } : { from: 'request' }) : undefined,
    },
    reasons: [`"${last}" is paired with "${counterpart}"`],
    caveats: [
      'Paired actions are inverses only if they reset every field the action touched — verify it',
      ...(sameArgs ? ['Assumes the counterpart takes the same arguments; items that were already present are removed by the undo too'] : []),
    ],
  });
}

/** Does a request matching `source` carry every field `target` requires, recursively (objects and array items)? */
function providesRequired(source: Schema | undefined, target: Schema | undefined, depth = 0): boolean {
  if (!target || !source || depth > 3) return true;
  if (target.items || source.items) return providesRequired(source.items, target.items, depth + 1);
  const theirs = target.properties ?? {};
  const ours = source.properties ?? {};
  if (!source.properties && target.required?.length) return false;
  for (const r of target.required ?? []) if (source.properties && !(r in ours)) return false;
  for (const [k, t] of Object.entries(theirs)) if (k in ours && !providesRequired(ours[k], t, depth + 1)) return false;
  return true;
}

function counterpartsOf(action: string): string[] {
  const out: string[] = [];
  for (const [a, b] of ACTION_PAIRS) {
    if (action === a) out.push(b);
    if (action === b) out.push(a);
  }
  if (action.startsWith('un')) out.push(action.slice(2));
  else out.push(`un${action}`);
  return out;
}

function parseRef(s: string): ValueRef {
  if (s === 'location') return { from: 'location', key: '' };
  const i = s.indexOf('.');
  const from = s.slice(0, i) as ValueRef['from'];
  if (i < 1 || !['params', 'query', 'response', 'before', 'request'].includes(from)) {
    throw new Error(`Bad binding "${s}": expected params.x, query.x, response.x, before.x, request.x or location`);
  }
  return { from, key: s.slice(i + 1) };
}

/** The verb of an operationId, ignoring namespaces like "repos/create-webhook". */
const verbOf = (op: Operation) => tokenize(op.id.split('/').pop() ?? op.id)[0] ?? '';

/** A POST whose name says it only computes or reads (check-token, bulk-list, search). */
function isReadOnlyPost(o: Operation): boolean {
  if (o.method !== 'post') return false;
  const last = segmentsOf(o.path).at(-1) ?? '';
  return [...tokenize(last), verbOf(o)].flatMap(stems).some((t) => SIDE_EFFECT_FREE_VERBS.has(t));
}

/** Every word of the operationId (without namespace), e.g. createAndSendInvoice -> create, and, send, invoice. */
const nameTokens = (op: Operation) => tokenize(op.id.split('/').pop() ?? op.id);

/** The first strong irreversible verb in free text that is not negated ("without sending"). */
function strongVerbIn(text: string | undefined, includePastTense = false): string | undefined {
  if (!text) return undefined;
  const words = tokenize(text);
  for (let i = 0; i < words.length; i++) {
    if (!STRONG_IRREVERSIBLE_VERBS.has(words[i]!) && !(includePastTense && PAST_TENSE_EFFECTS.has(words[i]!))) continue;
    const window = words.slice(Math.max(0, i - 3), i);
    if (!window.some((w) => NEGATIONS.has(w))) return words[i];
  }
  return undefined;
}

/** Find "GitHub-style" flat item routes: POST /repos/{o}/{r}/issues/{n}/comments -> DELETE /repos/{o}/{r}/issues/comments/{id}. */
function flatItemDeleteOf(index: Index, opPath: string): Operation | undefined {
  const segs = segmentsOf(opPath);
  const last = segs.at(-1)!;
  const parent = segs.slice(0, -1);
  const matches = index.ops.filter((o) => {
    if (o.method !== 'delete') return false;
    const s = segmentsOf(o.path);
    if (s.length < 2 || s.at(-2) !== last || !isParamSeg(s.at(-1)!)) return false;
    const prefix = s.slice(0, -2);
    if (prefix.length && prefix[0] !== parent[0]) return false; // empty prefix: a top-level route (Asana /sections/{gid})
    let j = 0; // prefix must be a subsequence of the parent route
    for (const seg of parent) if (seg === prefix[j]) j++;
    return j === prefix.length;
  });
  // Prefer the most specific route: /issues/comments/{id} over /comments/{id}.
  return matches.sort((a, b) => segmentsOf(b.path).length - segmentsOf(a.path).length)[0];
}

function deleteCreatedPlan(op: Operation, del: Operation, confidenceBoost = 0, reason?: string): InversePlan {
  const newParam = paramName(segmentsOf(del.path).at(-1)!);
  const id = idFieldFor(newParam, op.responseSchema);
  // The client often chooses the identifier itself (GitHub variables: POST {name, value}, DELETE …/{name}).
  const chosen = !id.known ? idFieldFor(newParam, op.requestSchema) : undefined;
  if (chosen?.known && !chosen.key.includes('.')) {
    return plan(op, 'reversible', 'delete-created', 0.75 + confidenceBoost, {
      inverse: {
        operationId: del.id,
        method: 'delete',
        path: del.path,
        bindings: bindParams(del.path, { [newParam]: { from: 'request', key: chosen.key } }),
      },
      reasons: [reason ?? `The client chooses the new resource's identifier (request.${chosen.key}); ${del.id} removes it`],
      caveats: ['If a resource with that identifier already existed, the create may have updated it instead'],
    });
  }
  if (id.list || (!id.known && op.responseSchema?.properties)) {
    return plan(op, 'unknown', 'none', 0, {
      reasons: [
        id.list
          ? `Returns a list, so the created item for ${del.id} can't be identified`
          : `Response has no field that identifies {${newParam}} for ${del.id}`,
      ],
      caveats: [
        'Declare bindings in an overrides file, e.g. { "inverse": "' + del.id + '", "bindings": { "' + newParam + '": "response.x" } }',
        'Or let `undogen learn` find the binding against a sandbox',
      ],
      suggestion: { inverse: del.id, param: newParam },
    });
  }
  return plan(op, 'reversible', 'delete-created', (id.known ? 0.9 : 0.5) + confidenceBoost, {
    inverse: {
      operationId: del.id,
      method: 'delete',
      path: del.path,
      bindings: bindParams(del.path, { [newParam]: { from: 'response', key: id.key } }),
    },
    reasons: [reason ?? `POST to a collection creates a resource; ${del.id} removes it`],
    caveats: id.known ? [] : [`Response schema does not declare an id; assuming "${id.key}"`],
  });
}

/** Compile the undo recipe for one mutating operation. */
export function planOperation(op: Operation, index: Index, override?: Declaration, options: AnalyzeOptions = {}): InversePlan {
  return finishPlan(oneWay(basePlan(op, index, override, options), op), op, index);
}

/** An unknown POST/DELETE named after a one-way transition (void, finalize, delete-request…) is irreversible. */
function oneWay(p: InversePlan, op: Operation): InversePlan {
  if (p.reversibility !== 'unknown' || p.suggestion || p.strategy !== 'none' || op.method === 'patch' || op.method === 'put') return p;
  const last = segmentsOf(op.path).at(-1) ?? '';
  const words = [...(isParamSeg(last) ? [] : tokenize(last)), ...nameTokens(op)].flatMap(stems);
  const verb = words.find((w) => ONE_WAY_VERBS.has(w));
  if (!verb) return p;
  return plan(op, 'irreversible', 'none', 0.6, {
    reasons: [`"${verb}" is a one-way transition and the API offers no counterpart`],
    caveats: ['Override with x-undogen or an overrides file if this operation is actually reversible'],
  });
}

function basePlan(op: Operation, index: Index, override: Declaration | undefined, options: AnalyzeOptions): InversePlan {
  // 0. Explicit declarations (overrides file, then x-undogen in the spec) always win.
  const declared = override ?? (op.extensions['x-undogen'] as Declaration | undefined);
  const source = override ? 'overrides file' : 'x-undogen';
  if (declared?.reversibility === 'irreversible') {
    return plan(op, 'irreversible', declared.strategy ?? 'declared', declared.confidence ?? 1, {
      reasons: [declared.reason ?? `Declared irreversible via ${source}`],
    });
  }
  if (declared?.inverse) {
    const target = index.byId(declared.inverse);
    if (!target) {
      return plan(op, 'unknown', 'none', 0, {
        reasons: [`${source}: inverse refers to unknown operation "${declared.inverse}"`],
      });
    }
    const overrides = Object.fromEntries(Object.entries(declared.bindings ?? {}).map(([k, v]) => [k, parseRef(v)]));
    const body: BodyTemplate | undefined =
      declared.body === 'request'
        ? { from: 'request' }
        : declared.body === 'before-request-keys'
          ? { from: 'before-request-keys' }
          : declared.body === 'before-json-patch'
            ? { from: 'before-json-patch' }
        : declared.body === 'before'
          ? { from: 'before', fields: writableFields(target.requestSchema) }
          : declared.body && typeof declared.body === 'object'
            ? { from: 'literal', value: declared.body.literal }
            : undefined;
    const getOp = index.find('get', op.path);
    const needsCapture = declared.body === 'before' || declared.body === 'before-request-keys' || declared.body === 'before-json-patch';
    const lastSeg = segmentsOf(op.path).at(-1) ?? '';
    // Undoing a DELETE by POSTing it back re-creates the resource under a new id: track it.
    const identity =
      op.method === 'delete' && target.method === 'post' && isParamSeg(lastSeg)
        ? { param: paramName(lastSeg), responseKey: idFieldFor(paramName(lastSeg), target.responseSchema).key }
        : undefined;
    const missingTarget = declared.inverseIfMissing ? index.byId(declared.inverseIfMissing) : undefined;
    return plan(op, declared.reversibility ?? 'reversible', declared.strategy ?? 'declared', declared.confidence ?? 1, {
      identity,
      inverseIfMissing: missingTarget
        ? { operationId: missingTarget.id, method: missingTarget.method, path: missingTarget.path, bindings: bindParams(missingTarget.path, overrides) }
        : undefined,
      capture: needsCapture && getOp ? getTemplate(getOp) : undefined,
      inverse: { operationId: target.id, method: target.method, path: target.path, bindings: bindParams(target.path, overrides), body },
      reasons: [declared.reason ?? `Inverse declared via ${source}: ${target.id}`],
    });
  }

  const segs = segmentsOf(op.path);
  const last = segs[segs.length - 1] ?? '';
  const lastIsParam = isParamSeg(last);
  const parentPath = joinPath(segs.slice(0, -1));
  const isCollection = !lastIsParam && index.hasItemChild(op.path);
  const isAction = !lastIsParam && !isCollection && segs.length >= 2 && isParamSeg(segs[segs.length - 2]!);

  // 1. Effects that leave the system cannot be undone; pure computations need no undo.
  // The last path segment names an action only for POST (POST /x/{id}/email); for PUT/PATCH it is a sub-resource.
  const verbTokens = [...(op.method === 'post' ? tokenize(last) : []), verbOf(op)].flatMap(stems);
  const offending =
    verbTokens.find((t) => IRREVERSIBLE_VERBS.has(t)) ??
    nameTokens(op).find((t) => STRONG_IRREVERSIBLE_VERBS.has(t)) ??
    strongVerbIn(op.summary);
  if (offending) {
    return plan(op, 'irreversible', 'none', 0.8, {
      reasons: [`"${offending}" describes an effect that cannot be called back (message, money, execution, or destruction)`],
      caveats: ['Override with x-undogen or an overrides file if this operation is actually reversible'],
    });
  }
  const pure = op.method === 'post' && verbTokens.find((t) => SIDE_EFFECT_FREE_VERBS.has(t));
  if (pure) {
    return plan(op, 'reversible', 'no-side-effects', 0.7, {
      reasons: [`"${pure}" computes a result without changing state`],
    });
  }

  // 1b. RPC-style APIs (Slack): POST /conversations.archive <-> POST /conversations.unarchive, same arguments.
  const rpc = op.method === 'post' && !lastIsParam ? /^(.+)\.([A-Za-z]+)$/.exec(last) : null;
  if (rpc) {
    const [, noun, verb] = rpc as unknown as [string, string, string];
    for (const counterpart of counterpartsOf(verb.toLowerCase())) {
      const target = index.ops.find(
        (o) => o.method === 'post' && segmentsOf(o.path).at(-1)?.toLowerCase() === `${noun}.${counterpart}`.toLowerCase() && joinPath(segmentsOf(o.path).slice(0, -1)) === parentPath,
      );
      if (target) {
        return plan(op, 'reversible', 'paired-action', 0.55, {
          inverse: { operationId: target.id, method: 'post', path: target.path, bindings: bindParams(target.path), body: { from: 'request' } },
          reasons: [`RPC method "${verb}" is paired with "${segmentsOf(target.path).at(-1)}"`],
          caveats: ['Assumes the counterpart takes the same arguments', 'Paired actions are inverses only if they reset every field the action touched — verify it'],
        });
      }
    }
  }

  // 1c. DELETE on a collection removes every item: no single request can bring them back.
  if (op.method === 'delete' && isCollection) {
    return plan(op, 'irreversible', 'none', 0.7, {
      reasons: ['Deletes every item in a collection; re-creating them all is not a safe inverse'],
      caveats: ['Declare an inverse with x-undogen if your API supports restoring the collection'],
    });
  }

  // 2. POST to a collection creates a resource -> delete what was created.
  if (op.method === 'post' && isCollection) {
    const itemPath = itemPathOf(index, op.path)!;
    const del = index.find('delete', itemPath);
    if (del) return deleteCreatedPlan(op, del);

    // No DELETE, but maybe the API soft-deletes via a state field (GitHub issues: state=closed).
    const soft = softDeleteOf(index, itemPath);
    if (soft) {
      const newParam = paramName(segmentsOf(itemPath).at(-1)!);
      const id = idFieldFor(newParam, op.responseSchema);
      return plan(op, 'compensable', 'soft-delete', id.known ? 0.7 : 0.45, {
        inverse: {
          operationId: soft.op.id,
          method: soft.op.method,
          path: itemPath,
          bindings: bindParams(itemPath, { [newParam]: { from: 'response', key: id.key } }),
          body: { from: 'literal', value: { [soft.field]: soft.value } },
        },
        reasons: [`No DELETE ${itemPath}; ${soft.op.id} can set ${soft.field}="${soft.value}" instead`],
        caveats: ['The resource still exists in a closed/archived state and may have notified people'],
      });
    }
    return plan(op, 'irreversible', 'none', 0.6, {
      reasons: [`Creates a resource but the API has no DELETE ${itemPath}`],
    });
  }

  // 2b. POST to a sub-collection whose items live at a flat route elsewhere.
  if (op.method === 'post' && !lastIsParam) {
    const flatDel = flatItemDeleteOf(index, op.path);
    if (flatDel) {
      const p = deleteCreatedPlan(op, flatDel, -0.15, `Creates a resource that ${flatDel.id} removes (flat item route)`);
      // A top-level match (/teams/{id} for POST …/restrictions/teams) is a weak signal: only take it
      // when the response names the created resource; otherwise let the other rules decide.
      const topLevel = segmentsOf(flatDel.path).length === 2;
      if (!(topLevel && p.reversibility === 'unknown')) return p;
    }
  }

  // 2c. PUT/PATCH on anything readable (singleton settings, sub-resources): snapshot and restore.
  if ((op.method === 'put' || op.method === 'patch') && !lastIsParam) {
    const getOp = index.find('get', op.path);
    if (getOp) {
      // If nothing was there before (GET 404), the PUT created it: the way back is the DELETE on the same route.
      const del = op.method === 'put' ? index.find('delete', op.path) : undefined;
      return plan(op, 'reversible', 'restore-snapshot', op.method === 'patch' ? 0.8 : 0.75, {
        capture: getTemplate(getOp),
        inverse: {
          operationId: op.id,
          method: op.method,
          path: op.path,
          bindings: bindParams(op.path),
          body: op.method === 'patch' ? patchBody(op) : { from: 'before', fields: writableFields(op.requestSchema) },
        },
        inverseIfMissing: del ? { operationId: del.id, method: 'delete', path: del.path, bindings: bindParams(del.path) } : undefined,
        reasons: [`Snapshot via ${getOp.id}, then write the old values back with ${op.id}`],
        caveats: ['Assumes the GET and the write use the same representation'],
      });
    }
  }

  // 3. Action endpoints: archive/unarchive, star (PUT) / unstar (DELETE same path), ...
  // 3a. Same route, opposite methods: PUT/DELETE …/star, or POST/DELETE …/selected_users with the same body.
  if (!lastIsParam && !isCollection && op.method !== 'patch') {
    const candidate =
      op.method === 'delete'
        ? index.find('put', op.path) ?? index.find('post', op.path)
        : index.find('delete', op.path);
    // A read-only POST on the same route (GitHub's check-token) is not the way back from a DELETE.
    const sameRouteOpposite = candidate && !isReadOnlyPost(candidate) ? candidate : undefined;
    if (sameRouteOpposite) {
      const acceptsBody = (o: Operation) => !!(o.requestSchema || o.requestExample !== undefined);
      const sendsBody = acceptsBody(op) && acceptsBody(sameRouteOpposite);
      return plan(op, 'reversible', 'toggle', isAction ? 0.65 : 0.55, {
        inverse: {
          operationId: sameRouteOpposite.id,
          method: sameRouteOpposite.method,
          path: op.path,
          bindings: bindParams(op.path),
          body: sendsBody ? { from: 'request' } : undefined,
        },
        reasons: [
          sendsBody
            ? `${op.method.toUpperCase()} and ${sameRouteOpposite.method.toUpperCase()} on the same route add and remove what the body names`
            : `${op.method.toUpperCase()} and ${sameRouteOpposite.method.toUpperCase()} on the same route toggle the same state`,
        ],
        caveats: [
          sendsBody
            ? 'Members that were already present before the call are removed by the undo too — verify it'
            : 'Only an inverse if the state actually changed (toggling an already-set flag is a no-op)',
        ],
      });
    }
  }

  if (isAction) {
    const paired = pairedActionPlan(op, index, parentPath, last);
    if (paired) return paired;
    return plan(op, 'unknown', 'none', 0, {
      reasons: [`Action endpoint "${last}" has no recognisable counterpart`],
      caveats: ['Declare one with x-undogen: { inverse: <operationId> }'],
    });
  }

  // 3b. Actions under a non-item route: POST …/notifications/markRead <-> …/markUnread.
  if (op.method === 'post' && !lastIsParam && !isCollection) {
    const paired = pairedActionPlan(op, index, parentPath, last);
    if (paired) return paired;
  }

  if (lastIsParam) {
    const getOp = index.find('get', op.path);

    // 4. PUT / PATCH an item -> snapshot it first, write the snapshot back.
    if (op.method === 'put' || op.method === 'patch') {
      if (!getOp) {
        const del = op.method === 'put' ? index.find('delete', op.path) : undefined;
        if (del) {
          return plan(op, 'reversible', 'toggle', 0.55, {
            inverse: { operationId: del.id, method: 'delete', path: op.path, bindings: bindParams(op.path) },
            reasons: ['PUT with a matching DELETE and no GET behaves like a set/unset toggle'],
            caveats: ['Assumes the resource did not exist before the PUT'],
          });
        }
        return plan(op, 'unknown', 'none', 0, {
          reasons: [`Cannot capture prior state: no GET ${op.path}`],
        });
      }
      const del = index.find('delete', op.path);
      return plan(op, 'reversible', 'restore-snapshot', op.method === 'patch' ? 0.9 : 0.85, {
        capture: getTemplate(getOp),
        inverse: {
          operationId: op.id,
          method: op.method,
          path: op.path,
          bindings: bindParams(op.path),
          body: op.method === 'patch' ? patchBody(op) : { from: 'before', fields: writableFields(op.requestSchema) },
        },
        inverseIfMissing: del && op.method === 'put'
          ? { operationId: del.id, method: 'delete', path: op.path, bindings: bindParams(op.path) }
          : undefined,
        reasons: [`Snapshot via ${getOp.id}, then write the old values back with ${op.id}`],
        caveats: op.method === 'patch' ? [] : ['Server-managed fields are not restored'],
      });
    }

    // 4b. POST to an item updates it (Stripe, Twilio): snapshot it first, POST the old values back.
    if (op.method === 'post' && getOp && !index.find('put', op.path) && !index.find('patch', op.path)) {
      const del = index.find('delete', op.path);
      return plan(op, 'reversible', 'restore-snapshot', 0.6, {
        capture: getTemplate(getOp),
        inverse: { operationId: op.id, method: 'post', path: op.path, bindings: bindParams(op.path), body: { from: 'before-request-keys' } },
        inverseIfMissing: del ? { operationId: del.id, method: 'delete', path: del.path, bindings: bindParams(del.path) } : undefined,
        reasons: [`POST to an item updates it (no PUT/PATCH): snapshot via ${getOp.id}, POST the old values back`],
        caveats: ['Assumes POST updates only the fields it is sent (Stripe-style partial update)', 'Nested and form-encoded fields are matched by name, ignoring case and separators'],
      });
    }

    // 5. DELETE an item -> snapshot it first, re-create it from the snapshot.
    if (op.method === 'delete') {
      if (!getOp) {
        return plan(op, 'irreversible', 'none', 0.7, {
          reasons: [`Cannot capture the resource before deletion: no GET ${op.path}`],
        });
      }
      const create = index.find('post', parentPath);
      if (create) {
        const param = paramName(last);
        const children = options.restoreChildren ? childPlansOf(index, op.path) : undefined;
        return plan(op, 'compensable', 'recreate-from-snapshot', 0.65, {
          identity: { param, responseKey: idFieldFor(param, create.responseSchema).key },
          children: children?.length ? children : undefined,
          capture: getTemplate(getOp),
          inverse: {
            operationId: create.id,
            method: 'post',
            path: create.path,
            bindings: bindParams(create.path),
            body: { from: 'before', fields: writableFields(create.requestSchema) },
          },
          reasons: [`Snapshot via ${getOp.id}, re-create with ${create.id}`],
          caveats: [
            'The re-created resource gets a new identifier',
            children?.length
              ? `Re-creates ${children.length} child collection(s) too; children get new identifiers and the caller as author`
              : 'Children removed by cascading deletes are not restored (see restoreChildren / --restore-children)',
          ],
        });
      }
      const upsert = index.find('put', op.path);
      if (upsert) {
        return plan(op, 'reversible', 'recreate-from-snapshot', 0.5, {
          capture: getTemplate(getOp),
          inverse: {
            operationId: upsert.id,
            method: 'put',
            path: op.path,
            bindings: bindParams(op.path),
            body: { from: 'before', fields: writableFields(upsert.requestSchema) },
          },
          reasons: [`Snapshot via ${getOp.id}, restore with ${upsert.id}`],
          caveats: ['Assumes PUT creates the resource when it does not exist (upsert)'],
        });
      }
      return plan(op, 'irreversible', 'none', 0.6, {
        reasons: ['Deletes a resource and the API offers no way to create it again'],
      });
    }
  }

  return plan(op, 'unknown', 'none', 0, {
    reasons: [`No rule matches ${op.method.toUpperCase()} ${op.path}`],
    caveats: ['Declare an inverse with x-undogen: { inverse: <operationId> }'],
  });
}

/**
 * Add what every plan needs regardless of strategy:
 * - a `check` GET, so the runtime can detect that someone changed what the agent wrote
 * - query parameters shared between the original operation and the target (api-version, ...)
 * - a caveat when the description mentions effects that cannot be called back
 */
function finishPlan(p: InversePlan, op: Operation, index: Index): InversePlan {
  if (!p.check && p.inverse) {
    if (p.capture && (p.strategy === 'restore-snapshot' || p.inverse.body?.from === 'before-request-keys' || p.inverse.body?.from === 'before-json-patch')) {
      p.check = p.capture;
    } else if (
      (p.inverse.method === 'delete' || p.strategy === 'soft-delete') &&
      ['delete-created', 'soft-delete', 'declared'].includes(p.strategy)
    ) {
      const getOp = index.find('get', p.inverse.path);
      if (getOp) p.check = { operationId: getOp.id, method: 'get', path: getOp.path, bindings: p.inverse.bindings };
    }
  }
  // Paired actions and toggles write no fields we can name: compare the state before and after instead.
  if (!p.check && p.inverse && (p.strategy === 'paired-action' || p.strategy === 'toggle')) {
    const exact = index.find('get', op.path);
    const segs = segmentsOf(op.path);
    const root = exact ? undefined : index.find('get', joinPath(segs.slice(0, -1)));
    const getOp = exact ?? root;
    if (getOp && getOp.path !== '/') {
      p.check = { operationId: getOp.id, method: 'get', path: getOp.path, bindings: bindParams(getOp.path) };
      p.checkMode = exact ? 'diff-exact' : 'diff';
    }
  }
  const byId = (id: string) => index.byId(id);
  const shared = new Set(op.queryParams?.map((q) => q.name) ?? []);
  const addQuery = (t: RequestTemplate | undefined) => {
    if (!t || !shared.size) return;
    const target = byId(t.operationId);
    const names = (target?.queryParams ?? []).map((q) => q.name).filter((n) => shared.has(n));
    if (names.length) t.query = { ...Object.fromEntries(names.map((n) => [n, { from: 'query' as const, key: n }])), ...t.query };
  };
  for (const t of [p.capture, p.inverse, p.inverseIfMissing, p.check]) addQuery(t);
  if (p.inverse?.body?.from === 'before-request-keys' && !p.inverse.body.nullMissing && p.inverse.operationId === op.id) {
    p.caveats.push('A field the call adds that did not exist before is not removed by the undo');
  }
  if (p.reversibility !== 'irreversible') {
    const verb = strongVerbIn(op.description, true);
    if (verb) p.caveats.push(`The description mentions "${verb}": side effects like that cannot be called back by any inverse`);
  }
  return p;
}

/** Child collections of an item route that can be listed and re-created: /todos/{todoId}/comments. */
const MAX_CHILD_DEPTH = 3;

function childPlansOf(index: Index, itemPath: string, depth = 1): ChildPlan[] {
  const out: ChildPlan[] = [];
  for (const list of index.ops) {
    if (list.method !== 'get') continue;
    const segs = segmentsOf(list.path);
    if (joinPath(segs.slice(0, -1)) !== structuralPath(itemPath) || isParamSeg(segs.at(-1)!)) continue;
    const create = index.find('post', list.path);
    const childItem = itemPathOf(index, list.path);
    if (!create || !childItem) continue;
    const param = paramName(segmentsOf(childItem).at(-1)!);
    out.push({
      list: { operationId: list.id, method: 'get', path: list.path, bindings: bindParams(list.path) },
      create: {
        operationId: create.id,
        method: 'post',
        path: create.path,
        bindings: bindParams(create.path),
        body: { from: 'before', fields: writableFields(create.requestSchema) },
      },
      param,
      idKey: idFieldFor(param, create.responseSchema).key,
      children: depth < MAX_CHILD_DEPTH ? nonEmpty(childPlansOf(index, childItem, depth + 1)) : undefined,
    });
  }
  return out;
}

const nonEmpty = <T>(xs: T[]) => (xs.length ? xs : undefined);

export interface AnalyzeOptions {
  /** Declarations for specs you don't control, keyed by operationId. */
  overrides?: Record<string, Declaration>;
  /**
   * When undoing a DELETE re-creates the resource, also capture and re-create its
   * child collections (comments of a todo, ...). Off by default: re-created children
   * get new ids and the caller as their author.
   */
  restoreChildren?: boolean;
}

/** Compile undo plans for every mutating operation in the spec. */
export function analyze(spec: ApiSpec, options: AnalyzeOptions = {}): Analysis {
  const index = buildIndex(spec);
  const known = new Set(spec.operations.map((o) => o.id));
  for (const id of Object.keys(options.overrides ?? {})) {
    if (!known.has(id)) throw new Error(`overrides: unknown operationId "${id}"`);
  }
  const plans = spec.operations
    .filter((o) => o.method !== 'get')
    .map((o) => planOperation(o, index, options.overrides?.[o.id], options));
  const summary = {
    reversible: 0,
    compensable: 0,
    irreversible: 0,
    unknown: 0,
    total: plans.length,
    readOnly: spec.operations.length - plans.length,
  };
  for (const p of plans) summary[p.reversibility]++;
  return { spec: { title: spec.title, version: spec.version }, plans, summary, warnings: spec.warnings ?? [] };
}
