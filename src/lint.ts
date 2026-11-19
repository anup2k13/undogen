import type { Analysis, ApiSpec, InversePlan } from './types.js';

export type LintSeverity = 'error' | 'warning' | 'info';

export interface LintFinding {
  operationId: string;
  method: string;
  path: string;
  /** Stable rule id, e.g. "create-without-id". */
  rule: string;
  severity: LintSeverity;
  /** What is wrong, in terms of undo. */
  message: string;
  /** The change to the API (or its description) that fixes it. */
  fix: string;
}

interface Rule {
  rule: string;
  severity: LintSeverity;
  match: RegExp;
  fix: (m: RegExpMatchArray, p: InversePlan) => string;
}

/**
 * Structural reasons the analyzer gives, mapped to the change that removes them.
 * Irreversibility that comes from what an operation does (sending, charging) is
 * reported as info: no API change makes an email unsent.
 */
const RULES: Rule[] = [
  {
    rule: 'create-without-id',
    severity: 'error',
    match: /^Response has no field that identifies \{([^}]+)\} for (.+)$/,
    fix: (m) => `Return the created resource's identifier in the response (a field named "id" or "${m[1]}"), or a Location header pointing at it`,
  },
  {
    rule: 'create-returns-list',
    severity: 'error',
    match: /^Returns a list, so the created item for (.+) can't be identified$/,
    fix: () => 'Return the created resource itself (with its identifier), not a list',
  },
  {
    rule: 'create-without-delete',
    severity: 'error',
    match: /^Creates a resource but the API has no DELETE (.+)$/,
    fix: (m) => `Add DELETE ${m[1]}, or a PATCH on it with a state/status enum that includes "closed" or "archived"`,
  },
  {
    rule: 'write-without-get',
    severity: 'error',
    match: /^Cannot capture prior state: no GET (.+)$/,
    fix: (m) => `Add GET ${m[1]} so the state before the change can be read and written back`,
  },
  {
    rule: 'delete-without-get',
    severity: 'error',
    match: /^Cannot capture the resource before deletion: no GET (.+)$/,
    fix: (m) => `Add GET ${m[1]} so a deleted resource can be captured and re-created`,
  },
  {
    rule: 'delete-without-create',
    severity: 'warning',
    match: /^Deletes a resource and the API offers no way to create it again$/,
    fix: (_m, p) => `Add POST to the collection of ${p.path}, or make PUT ${p.path} create it (upsert), so a deleted resource can be restored`,
  },
  {
    rule: 'action-without-counterpart',
    severity: 'warning',
    match: /^Action endpoint "(.+)" has no recognisable counterpart$/,
    fix: (m) => `Add the opposite action next to it (e.g. "un${m[1]}"), or declare its inverse with x-undogen: { inverse: <operationId> }`,
  },
  {
    rule: 'no-rule',
    severity: 'warning',
    match: /^No rule matches /,
    fix: () => 'Declare how to undo it with x-undogen: { inverse: <operationId>, bindings: {...} }, or { reversibility: irreversible, reason } if it cannot be undone',
  },
  {
    rule: 'one-way-transition',
    severity: 'info',
    match: /is a one-way transition and the API offers no counterpart$/,
    fix: () => 'If the transition can be reversed, add the reverse operation; otherwise declare x-undogen: { reversibility: irreversible, reason } to make it explicit',
  },
  {
    rule: 'external-effect',
    severity: 'info',
    match: /describes an effect that cannot be called back/,
    fix: () => 'Nothing to change if this is right; agents will need approval to call it. If it is actually reversible, declare x-undogen with its inverse',
  },
  {
    rule: 'bulk-delete',
    severity: 'info',
    match: /^Deletes every item in a collection/,
    fix: () => 'Nothing to change if this is right; agents will need approval to call it',
  },
];

/** Caveats that point at a missing piece of the description, not at the API. */
const CAVEAT_RULES: Rule[] = [
  {
    rule: 'undeclared-response-id',
    severity: 'warning',
    match: /^Response schema does not declare an id; assuming "(.+)"$/,
    fix: (m) => `Describe the response body in the spec, including the "${m[1]}" field`,
  },
];

/**
 * Concrete changes that would make more of an API undoable: what to add to the
 * API or its description, operation by operation. `analyze` says what can't be
 * undone; `lint` says what to change.
 */
export function lint(spec: ApiSpec, analysis: Analysis): LintFinding[] {
  const findings: LintFinding[] = [];
  const opById = new Map(spec.operations.map((o) => [o.id, o]));
  for (const p of analysis.plans) {
    const base = { operationId: p.operationId, method: p.method.toUpperCase(), path: p.path };
    const op = opById.get(p.operationId);
    if (op && !op.extensions['x-undogen'] && p.operationId === `${p.method.toUpperCase()} ${p.path}`) {
      findings.push({ ...base, rule: 'missing-operation-id', severity: 'warning', message: 'The operation has no operationId', fix: 'Add an operationId: overrides, journals and tools refer to operations by it' });
    }
    if (p.reversibility === 'unknown' || p.reversibility === 'irreversible') {
      const reason = p.reasons[0] ?? '';
      const r = RULES.find((x) => x.match.test(reason));
      if (r && p.strategy !== 'declared') {
        findings.push({ ...base, rule: r.rule, severity: r.severity, message: reason, fix: r.fix(reason.match(r.match)!, p) });
      }
    }
    for (const caveat of p.caveats) {
      const r = CAVEAT_RULES.find((x) => x.match.test(caveat));
      if (r) findings.push({ ...base, rule: r.rule, severity: r.severity, message: caveat, fix: r.fix(caveat.match(r.match)!, p) });
    }
  }
  const order: Record<LintSeverity, number> = { error: 0, warning: 1, info: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}
