/** Structural state comparison shared by the verifier and safe undo. */

export const DEFAULT_IGNORED_FIELDS = [
  'createdAt', 'updatedAt', 'created_at', 'updated_at', 'modifiedAt', 'modified_at',
  'lastModified', 'last_modified', 'etag', 'ETag',
];

export interface StateDiff {
  /** The GET route whose response differed, e.g. "GET /todos/{todoId}/comments". */
  resource: string;
  /** JSON path inside the response, e.g. "$[0].done" or "status". */
  path: string;
  before: unknown;
  after: unknown;
}

const SNAPSHOT_MISSING = Symbol('missing');

export interface NormalizeOptions {
  ignore: Set<string>;
  /** Keys that identify records; dropped (and arrays compared as multisets) when identities change. */
  identityKeys?: Set<string>;
}

/** Compare two values and return every leaf-level difference, as JSON paths. */
export function diffValues(before: unknown, after: unknown, opts: NormalizeOptions, resource = ''): StateDiff[] {
  const diffs: StateDiff[] = [];
  deepDiff(normalize(before, opts), normalize(after, opts), '$', (path, x, y) => diffs.push({ resource, path, before: x, after: y }));
  return diffs;
}

type State = Map<string, { status: number; data: unknown }>;

/** Compare two snapshots and return every leaf-level difference. */
export function diffStates(
  before: State,
  after: State,
  opts: NormalizeOptions,
): StateDiff[] {
  const diffs: StateDiff[] = [];
  for (const [resource, b] of before) {
    const a = after.get(resource);
    if (!a) continue;
    if (b.status !== a.status) {
      diffs.push({ resource, path: 'status', before: b.status, after: a.status });
      continue;
    }
    deepDiff(normalize(b.data, opts), normalize(a.data, opts), '$', (path, x, y) =>
      diffs.push({ resource, path, before: x, after: y }),
    );
  }
  return diffs;
}

export function normalize(value: unknown, opts: NormalizeOptions): unknown {
  if (Array.isArray(value)) {
    const items = value.map((v) => normalize(v, opts));
    // Without stable identities, order is meaningless: compare as a multiset.
    return opts.identityKeys ? items.sort((x, y) => stable(x).localeCompare(stable(y))) : items;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (opts.ignore.has(k) || opts.identityKeys?.has(k)) continue;
      out[k] = normalize(v, opts);
    }
    return out;
  }
  return value;
}

export function stable(v: unknown): string {
  return JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x,
  );
}

function deepDiff(a: unknown, b: unknown, path: string, emit: (p: string, a: unknown, b: unknown) => void): void {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      deepDiff(i < a.length ? a[i] : SNAPSHOT_MISSING, i < b.length ? b[i] : SNAPSHOT_MISSING, `${path}[${i}]`, emit);
    }
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const ao = a as Record<string, unknown>;
      const bo = b as Record<string, unknown>;
      deepDiff(k in ao ? ao[k] : SNAPSHOT_MISSING, k in bo ? bo[k] : SNAPSHOT_MISSING, `${path}.${k}`, emit);
    }
    return;
  }
  if (stable(a) !== stable(b)) {
    emit(path, a === SNAPSHOT_MISSING ? undefined : a, b === SNAPSHOT_MISSING ? undefined : b);
  }
}
