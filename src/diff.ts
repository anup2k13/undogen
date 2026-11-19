import type { Analysis, InversePlan, Reversibility } from './types.js';

/** Higher is better: what an agent can rely on. Unknown ranks above irreversible only in that it might be fixed by a declaration. */
const RANK: Record<Reversibility, number> = { reversible: 3, compensable: 2, unknown: 1, irreversible: 0 };

export type ChangeKind = 'regressed' | 'improved' | 'inverse-changed';

export interface PlanChange {
  operationId: string;
  method: string;
  path: string;
  kind: ChangeKind;
  from: Pick<InversePlan, 'reversibility' | 'strategy'> & { inverse?: string };
  to: Pick<InversePlan, 'reversibility' | 'strategy'> & { inverse?: string };
  reason: string;
}

export interface AnalysisDiff {
  from: { title: string; version: string };
  to: { title: string; version: string };
  /** New write operations, with how they can be undone. */
  added: InversePlan[];
  /** Write operations that no longer exist. */
  removed: InversePlan[];
  changed: PlanChange[];
  summary: { added: number; addedGated: number; removed: number; regressed: number; improved: number; inverseChanged: number };
}

const describeInverse = (p: InversePlan) => (p.inverse ? `${p.inverse.method.toUpperCase()} ${p.inverse.path}` : undefined);
const brief = (p: InversePlan) => ({ reversibility: p.reversibility, strategy: p.strategy, inverse: describeInverse(p) });

/**
 * Compare the compiled plans of two versions of an API. Operations are matched
 * by operationId, falling back to method + path when an id was renamed.
 * A change is a regression when an operation becomes harder to undo
 * (reversible → compensable → unknown → irreversible).
 */
export function diffAnalyses(before: Analysis, after: Analysis): AnalysisDiff {
  const key = (p: InversePlan) => `${p.method} ${p.path}`;
  const oldById = new Map(before.plans.map((p) => [p.operationId, p]));
  const oldByRoute = new Map(before.plans.map((p) => [key(p), p]));
  const matched = new Set<InversePlan>();
  const added: InversePlan[] = [];
  const changed: PlanChange[] = [];

  for (const p of after.plans) {
    const old = oldById.get(p.operationId) ?? oldByRoute.get(key(p));
    if (!old || matched.has(old)) {
      added.push(p);
      continue;
    }
    matched.add(old);
    const base = { operationId: p.operationId, method: p.method.toUpperCase(), path: p.path, from: brief(old), to: brief(p) };
    const delta = RANK[p.reversibility] - RANK[old.reversibility];
    if (delta < 0) {
      changed.push({ ...base, kind: 'regressed', reason: p.reasons[0] ?? `now ${p.reversibility}` });
    } else if (delta > 0) {
      changed.push({ ...base, kind: 'improved', reason: p.reasons[0] ?? `now ${p.reversibility}` });
    } else if (describeInverse(old) !== describeInverse(p) || old.inverse?.operationId !== p.inverse?.operationId) {
      changed.push({ ...base, kind: 'inverse-changed', reason: p.reasons[0] ?? 'the inverse request changed' });
    }
  }
  const removed = before.plans.filter((p) => !matched.has(p));
  const gated = (p: InversePlan) => p.reversibility === 'irreversible' || p.reversibility === 'unknown';
  return {
    from: before.spec,
    to: after.spec,
    added,
    removed,
    changed,
    summary: {
      added: added.length,
      addedGated: added.filter(gated).length,
      removed: removed.length,
      regressed: changed.filter((c) => c.kind === 'regressed').length,
      improved: changed.filter((c) => c.kind === 'improved').length,
      inverseChanged: changed.filter((c) => c.kind === 'inverse-changed').length,
    },
  };
}

/** A Markdown summary, e.g. for a pull request comment. */
export function diffToMarkdown(d: AnalysisDiff): string {
  const s = d.summary;
  const out = [
    `### Reversibility changes: ${d.from.title} ${d.from.version} → ${d.to.version}`,
    '',
    `**${s.regressed} regressed** · ${s.improved} improved · ${s.inverseChanged} inverse changed · ${s.added} added (${s.addedGated} gated) · ${s.removed} removed`,
    '',
  ];
  const rows = (title: string, list: PlanChange[]) => {
    if (!list.length) return;
    out.push(`#### ${title}`, '', '| Operation | Route | Before | After | Why |', '|---|---|---|---|---|');
    for (const c of list) {
      const cell = (x: PlanChange['from']) => `${x.reversibility}${x.inverse ? ` (${x.inverse})` : ''}`;
      out.push(`| \`${c.operationId}\` | \`${c.method} ${c.path}\` | ${cell(c.from)} | ${cell(c.to)} | ${c.reason.replace(/\|/g, '\\|')} |`);
    }
    out.push('');
  };
  rows('Regressed: harder to undo', d.changed.filter((c) => c.kind === 'regressed'));
  rows('Inverse changed', d.changed.filter((c) => c.kind === 'inverse-changed'));
  rows('Improved', d.changed.filter((c) => c.kind === 'improved'));
  if (d.added.length) {
    out.push('#### New write operations', '', '| Operation | Route | Undo |', '|---|---|---|');
    for (const p of d.added) out.push(`| \`${p.operationId}\` | \`${p.method.toUpperCase()} ${p.path}\` | ${p.reversibility}${p.inverse ? ` via \`${p.inverse.operationId}\`` : ''} |`);
    out.push('');
  }
  if (d.removed.length) out.push(`Removed: ${d.removed.map((p) => `\`${p.operationId}\``).join(', ')}`, '');
  return out.join('\n');
}
