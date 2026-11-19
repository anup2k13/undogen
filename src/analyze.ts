import type {
  Analysis,
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
];

/** Verbs whose effects leave the system boundary or cannot be called back. */
const IRREVERSIBLE_VERBS = new Set([
  'send', 'email', 'mail', 'notify', 'sms', 'broadcast', 'charge', 'pay', 'payout',
  'transfer', 'refund', 'purge', 'wipe', 'shred', 'deliver', 'dispatch', 'execute', 'remind',
  'cancel', 'merge', 'revoke', 'rerun', 'rerequest', 'ping', 'redeliver', 'dismiss', 'trigger',
  // Kubernetes-style subresources: run code, move traffic, evict, bind, mint credentials, finalize.
  'exec', 'portforward', 'proxy', 'eviction', 'evict', 'binding', 'token', 'finalize',
]);

/** Verbs for POSTs that compute something and change nothing. */
const SIDE_EFFECT_FREE_VERBS = new Set([
  'render', 'preview', 'search', 'query', 'validate', 'lint', 'estimate', 'simulate', 'compare', 'diff',
  // Kubernetes access reviews only answer a question. A bare "review" is NOT here: on other APIs it
  // approves deployments or grants access.
  'selfsubjectreview', 'tokenreview', 'subjectaccessreview', 'selfsubjectaccessreview',
  'localsubjectaccessreview', 'selfsubjectrulesreview',
]);

/** Values of a state/status field that mean "this is gone" for APIs without DELETE. */
const SOFT_DELETE_STATES = ['closed', 'archived', 'cancelled', 'canceled', 'inactive', 'deleted', 'disabled', 'revoked'];

/** Crude singularisation so "dispatches"/"pings" match "dispatch"/"ping". */
const stems = (t: string) => [t, t.replace(/es$/, ''), t.replace(/s$/, '')];

const MUTATING: HttpMethod[] = ['post', 'put', 'patch', 'delete'];

const isParamSeg = (seg: string) => /^\{[^}]+\}$/.test(seg);
const segmentsOf = (path: string) => path.split('/').filter(Boolean);
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
  hasItemChild(path: string): boolean;
}

function buildIndex(spec: ApiSpec): Index {
  const byKey = new Map(spec.operations.map((o) => [`${o.method} ${o.path}`, o]));
  const paths = new Set(spec.operations.map((o) => o.path));
  return {
    ops: spec.operations,
    find: (method, path) => byKey.get(`${method} ${path}`),
    hasItemChild: (path) => {
      for (const p of paths) {
        const segs = segmentsOf(p);
        if (segs.length && isParamSeg(segs[segs.length - 1]!) && joinPath(segs.slice(0, -1)) === path) return true;
      }
      return false;
    },
  };
}

/** Find the path that addresses a single item of `collectionPath`, e.g. /todos -> /todos/{todoId}. */
function itemPathOf(index: Index, collectionPath: string): string | undefined {
  for (const op of index.ops) {
    const segs = segmentsOf(op.path);
    if (segs.length && isParamSeg(segs[segs.length - 1]!) && joinPath(segs.slice(0, -1)) === collectionPath) {
      return op.path;
    }
  }
  return undefined;
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
  const i = s.indexOf('.');
  const from = s.slice(0, i) as ValueRef['from'];
  if (i < 1 || !['params', 'response', 'before', 'request'].includes(from)) {
    throw new Error(`Bad binding "${s}": expected params.x, response.x, before.x or request.x`);
  }
  return { from, key: s.slice(i + 1) };
}

/** The verb of an operationId, ignoring namespaces like "repos/create-webhook". */
const verbOf = (op: Operation) => tokenize(op.id.split('/').pop() ?? op.id)[0] ?? '';

/** Find "GitHub-style" flat item routes: POST /repos/{o}/{r}/issues/{n}/comments -> DELETE /repos/{o}/{r}/issues/comments/{id}. */
function flatItemDeleteOf(index: Index, opPath: string): Operation | undefined {
  const segs = segmentsOf(opPath);
  const last = segs.at(-1)!;
  const parent = segs.slice(0, -1);
  const matches = index.ops.filter((o) => {
    if (o.method !== 'delete') return false;
    const s = segmentsOf(o.path);
    if (s.length < 3 || s.at(-2) !== last || !isParamSeg(s.at(-1)!)) return false;
    const prefix = s.slice(0, -2);
    if (prefix[0] !== parent[0]) return false;
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
  if (id.list || (!id.known && op.responseSchema?.properties)) {
    return plan(op, 'unknown', 'none', 0, {
      reasons: [
        id.list
          ? `Returns a list, so the created item for ${del.id} can't be identified`
          : `Response has no field that identifies {${newParam}} for ${del.id}`,
      ],
      caveats: ['Declare bindings in an overrides file, e.g. { "inverse": "' + del.id + '", "bindings": { "' + newParam + '": "request.x" } }'],
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
export function planOperation(op: Operation, index: Index, override?: Declaration): InversePlan {
  // 0. Explicit declarations (overrides file, then x-undogen in the spec) always win.
  const declared = override ?? (op.extensions['x-undogen'] as Declaration | undefined);
  const source = override ? 'overrides file' : 'x-undogen';
  if (declared?.reversibility === 'irreversible') {
    return plan(op, 'irreversible', 'declared', 1, {
      reasons: [declared.reason ?? `Declared irreversible via ${source}`],
    });
  }
  if (declared?.inverse) {
    const target = index.ops.find((o) => o.id === declared.inverse);
    if (!target) {
      return plan(op, 'unknown', 'none', 0, {
        reasons: [`${source}: inverse refers to unknown operation "${declared.inverse}"`],
      });
    }
    const overrides = Object.fromEntries(Object.entries(declared.bindings ?? {}).map(([k, v]) => [k, parseRef(v)]));
    const body: BodyTemplate | undefined =
      declared.body === 'request'
        ? { from: 'request' }
        : declared.body === 'before'
          ? { from: 'before', fields: writableFields(target.requestSchema) }
          : declared.body && typeof declared.body === 'object'
            ? { from: 'literal', value: declared.body.literal }
            : undefined;
    const getOp = index.find('get', op.path);
    return plan(op, declared.reversibility ?? 'reversible', 'declared', 1, {
      capture: declared.body === 'before' && getOp ? getTemplate(getOp) : undefined,
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
  const verbTokens = [...(isAction || op.method === 'post' ? tokenize(last) : []), verbOf(op)].flatMap(stems);
  const offending = verbTokens.find((t) => IRREVERSIBLE_VERBS.has(t));
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

  // 1b. DELETE on a whole collection: a bulk delete of unknown size.
  if (op.method === 'delete' && isCollection) {
    return plan(op, 'irreversible', 'none', 0.8, {
      reasons: ['Deletes every matching item in the collection at once'],
      caveats: ['Delete items one by one through the item route to get an undo for each'],
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
      return deleteCreatedPlan(op, flatDel, -0.15, `Creates a resource that ${flatDel.id} removes (flat item route)`);
    }
  }

  // 2c. PUT/PATCH on anything readable (singleton settings, sub-resources): snapshot and restore.
  if ((op.method === 'put' || op.method === 'patch') && !lastIsParam) {
    const getOp = index.find('get', op.path);
    if (getOp) {
      return plan(op, 'reversible', 'restore-snapshot', op.method === 'patch' ? 0.8 : 0.75, {
        capture: getTemplate(getOp),
        inverse: {
          operationId: op.id,
          method: op.method,
          path: op.path,
          bindings: bindParams(op.path),
          body: op.method === 'patch' ? { from: 'before-request-keys' } : { from: 'before', fields: writableFields(op.requestSchema) },
        },
        reasons: [`Snapshot via ${getOp.id}, then write the old values back with ${op.id}`],
        caveats: ['Assumes the GET and the write use the same representation'],
      });
    }
  }

  // 3. Action endpoints: archive/unarchive, star (PUT) / unstar (DELETE same path), ...
  if (isAction) {
    const sameRouteOpposite =
      op.method === 'delete'
        ? index.find('put', op.path) ?? index.find('post', op.path)
        : index.find('delete', op.path);
    if (sameRouteOpposite) {
      return plan(op, 'reversible', 'toggle', 0.65, {
        inverse: {
          operationId: sameRouteOpposite.id,
          method: sameRouteOpposite.method,
          path: op.path,
          bindings: bindParams(op.path),
        },
        reasons: [`${op.method.toUpperCase()} and ${sameRouteOpposite.method.toUpperCase()} on the same route toggle the same state`],
        caveats: ['Only an inverse if the state actually changed (toggling an already-set flag is a no-op)'],
      });
    }
    for (const counterpart of counterpartsOf(last.toLowerCase())) {
      const counterpartPath = `${parentPath}/${counterpart}`;
      const target = MUTATING.map((m) => index.find(m, counterpartPath)).find(Boolean);
      if (target) {
        return plan(op, 'reversible', 'paired-action', 0.7, {
          inverse: {
            operationId: target.id,
            method: target.method,
            path: target.path,
            bindings: bindParams(target.path),
          },
          reasons: [`"${last}" is paired with "${counterpart}"`],
          caveats: ['Paired actions are inverses only if they reset every field the action touched — verify it'],
        });
      }
    }
    return plan(op, 'unknown', 'none', 0, {
      reasons: [`Action endpoint "${last}" has no recognisable counterpart`],
      caveats: ['Declare one with x-undogen: { inverse: <operationId> }'],
    });
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
          body: op.method === 'patch' ? { from: 'before-request-keys' } : { from: 'before', fields: writableFields(op.requestSchema) },
        },
        inverseIfMissing: del && op.method === 'put'
          ? { operationId: del.id, method: 'delete', path: op.path, bindings: bindParams(op.path) }
          : undefined,
        reasons: [`Snapshot via ${getOp.id}, then write the old values back with ${op.id}`],
        caveats: op.method === 'patch' ? [] : ['Server-managed fields are not restored'],
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
        return plan(op, 'compensable', 'recreate-from-snapshot', 0.65, {
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
            'Children removed by cascading deletes are not restored unless the verifier proves otherwise',
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

/** Pick the read that tells whether the resource changed after the agent's write. */
function guardFor(p: InversePlan, index: Index): RequestTemplate | undefined {
  if (p.strategy === 'restore-snapshot') return p.capture;
  if ((p.strategy === 'delete-created' || p.strategy === 'soft-delete') && p.inverse) {
    const get = index.find('get', p.inverse.path);
    if (get) return { operationId: get.id, method: 'get', path: p.inverse.path, bindings: p.inverse.bindings };
  }
  if (p.strategy === 'paired-action' || p.strategy === 'toggle') {
    const segs = segmentsOf(p.path);
    const root = joinPath(segs.slice(0, -1));
    const get = segs.length > 1 && isParamSeg(segs.at(-2)!) ? index.find('get', root) : undefined;
    if (get) return { operationId: get.id, method: 'get', path: root, bindings: bindParams(root) };
  }
  return undefined;
}

export interface AnalyzeOptions {
  /** Declarations for specs you don't control, keyed by operationId. */
  overrides?: Record<string, Declaration>;
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
    .map((o) => planOperation(o, index, options.overrides?.[o.id]))
    .map((p) => {
      const guard = guardFor(p, index);
      return guard ? { ...p, guard } : p;
    });
  const summary = {
    reversible: 0,
    compensable: 0,
    irreversible: 0,
    unknown: 0,
    total: plans.length,
    readOnly: spec.operations.length - plans.length,
  };
  for (const p of plans) summary[p.reversibility]++;
  return { spec: { title: spec.title, version: spec.version }, plans, summary };
}
