import type { Analysis, InversePlan, RequestTemplate, Reversibility } from './types.js';
import type { Outcome, VerifyReport } from './verify.js';

const useColor = !process.env.NO_COLOR && (!!process.env.FORCE_COLOR || process.stdout.isTTY);
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  bold: paint(1),
  dim: paint(2),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  blue: paint(34),
  magenta: paint(35),
  cyan: paint(36),
};

const CLASS_COLOR: Record<Reversibility, (s: string) => string> = {
  reversible: c.green,
  compensable: c.cyan,
  irreversible: c.red,
  unknown: c.yellow,
};

const OUTCOME_ICON: Record<Outcome, string> = {
  verified: c.green('✓'),
  failed: c.red('✗'),
  inconclusive: c.yellow('?'),
  gated: c.magenta('⛔'),
  skipped: c.dim('–'),
  error: c.yellow('!'),
};

const pad = (s: string, n: number) => s + ' '.repeat(Math.max(1, n - s.length));

function describeTemplate(t: RequestTemplate): string {
  const binds = Object.entries(t.bindings)
    .filter(([, r]) => r.from !== 'params')
    .map(([k, r]) => `${k} ← ${r.from}.${r.key}`);
  let body = '';
  if (t.body?.from === 'before') body = t.body.fields === '*' ? 'body ← before' : `body ← before.{${t.body.fields.join(',')}}`;
  if (t.body?.from === 'before-request-keys') body = t.body.nullMissing ? 'body ← before[keys sent], null if new' : 'body ← before[keys sent]';
  if (t.body?.from === 'before-json-patch') body = 'body ← inverse JSON Patch from before';
  if (t.body?.from === 'request') body = t.body.fields ? `body ← request.{${t.body.fields.join(',')}}` : 'body ← request';
  if (t.body?.from === 'literal') body = `body = ${JSON.stringify(t.body.value)}`;
  return [`${t.method.toUpperCase()} ${t.path}`, ...binds, body].filter(Boolean).join('  ');
}

export function formatAnalysis(a: Analysis): string {
  const lines: string[] = [];
  const idW = Math.max(12, ...a.plans.map((p) => p.operationId.length)) + 2;
  const pathW = Math.max(10, ...a.plans.map((p) => p.path.length)) + 2;
  lines.push('');
  lines.push(`${c.bold('undogen analyze')}  ${c.dim('·')}  ${a.spec.title} ${c.dim(a.spec.version)}  ${c.dim('·')}  ${a.summary.total} write operations`);
  lines.push('');
  for (const p of a.plans) {
    const cls = CLASS_COLOR[p.reversibility](pad(p.reversibility, 13));
    lines.push(
      `  ${pad(p.operationId, idW)}${pad(p.method.toUpperCase(), 7)}${pad(p.path, pathW)}${cls}${pad(p.strategy, 24)}${c.dim(p.confidence.toFixed(2))}`,
    );
    if (p.capture) lines.push(c.dim(`      ◉ capture  ${describeTemplate(p.capture)}`));
    if (p.inverse) lines.push(c.dim(`      ↺ undo     ${describeTemplate(p.inverse)}`));
    if (p.inverseIfMissing) lines.push(c.dim(`      ↺ if new   ${describeTemplate(p.inverseIfMissing)}`));
    if (!p.inverse) lines.push(c.dim(`      · ${p.reasons[0] ?? ''}`));
    for (const cav of p.caveats) lines.push(c.yellow(`      ⚠ ${cav}`));
  }
  const s = a.summary;
  lines.push('');
  lines.push(
    `  ${c.green(`${s.reversible} reversible`)} · ${c.cyan(`${s.compensable} compensable`)} · ${c.red(`${s.irreversible} irreversible`)} · ${c.yellow(`${s.unknown} unknown`)}  ${c.dim(`(${s.readOnly} read-only skipped)`)}`,
  );
  lines.push(c.dim(`  Compiled plans are hypotheses. Run \`undogen verify\` to prove them.`));
  lines.push('');
  return lines.join('\n');
}

const fmt = (v: unknown) => (v === undefined ? '(missing)' : JSON.stringify(v));

export function formatResultLine(r: VerifyReport['results'][number], idW = 22, pathW = 34): string {
  const lines = [
    `  ${OUTCOME_ICON[r.outcome]} ${pad(r.operationId, idW)}${pad(r.method, 7)}${pad(r.path, pathW)}${CLASS_COLOR[r.reversibility](pad(r.reversibility, 13))}${c.dim(r.detail)}`,
  ];
  const byResource = new Map<string, typeof r.diffs>();
  for (const d of r.diffs) byResource.set(d.resource, [...(byResource.get(d.resource) ?? []), d]);
  for (const [resource, diffs] of byResource) {
    lines.push(`      ${c.dim(resource)}`);
    for (const d of diffs.slice(0, 6)) {
      lines.push(`        ${pad(d.path, 14)}${c.green(fmt(d.before))}  →  ${c.red(fmt(d.after))}`);
    }
    if (diffs.length > 6) lines.push(c.dim(`        … ${diffs.length - 6} more`));
  }
  return lines.join('\n');
}

export function formatSummary(report: VerifyReport): string {
  const s = report.summary;
  return [
    '',
    `  ${c.green(`${s.verified} verified`)} · ${c.red(`${s.failed} failed`)}${s.inconclusive ? ` · ${c.yellow(`${s.inconclusive} inconclusive`)}` : ''} · ${c.magenta(`${s.gated} gated`)} · ${c.yellow(`${s.error} errors`)} · ${c.dim(`${s.skipped} skipped`)}`,
    '',
  ].join('\n');
}

export function toMarkdown(report: VerifyReport): string {
  const icon: Record<Outcome, string> = { verified: '✅', failed: '❌', inconclusive: '❔', gated: '⛔', skipped: '➖', error: '⚠️' };
  const s = report.summary;
  const out = [
    `# Reversibility report: ${report.spec.title} ${report.spec.version}`,
    '',
    `Generated by undogen ${report.tool.version} against \`${report.baseUrl}\` on ${report.finishedAt}.`,
    '',
    `**${s.verified} verified** · **${s.failed} failed** · ${s.inconclusive} inconclusive · ${s.gated} gated · ${s.error} errors · ${s.skipped} skipped`,
    '',
    '| | Operation | Route | Class | Result |',
    '|---|---|---|---|---|',
    ...report.results.map(
      (r) => `| ${icon[r.outcome]} | \`${r.operationId}\` | \`${r.method} ${r.path}\` | ${r.reversibility} | ${r.detail.replace(/\|/g, '\\|')} |`,
    ),
  ];
  const failed = report.results.filter((r) => r.diffs.length);
  if (failed.length) {
    out.push('', '## State left behind by failed undos', '');
    for (const r of failed) {
      out.push(`### \`${r.operationId}\``, '', '| Resource | Path | Before | After undo |', '|---|---|---|---|');
      for (const d of r.diffs) out.push(`| \`${d.resource}\` | \`${d.path}\` | \`${fmt(d.before)}\` | \`${fmt(d.after)}\` |`);
      out.push('');
    }
  }
  return out.join('\n') + '\n';
}

/** A shields.io endpoint badge: https://shields.io/badges/endpoint-badge */
export function toBadge(report: VerifyReport): object {
  const { verified, failed, error, inconclusive } = report.summary;
  const tested = verified + failed + error + inconclusive;
  const color = failed + error + inconclusive === 0 ? 'brightgreen' : verified / Math.max(1, tested) >= 0.75 ? 'yellow' : 'red';
  return { schemaVersion: 1, label: 'undo verified', message: `${verified}/${tested}`, color };
}

export function planCounts(plans: InversePlan[]): Record<Reversibility, number> {
  const out = { reversible: 0, compensable: 0, irreversible: 0, unknown: 0 };
  for (const p of plans) out[p.reversibility]++;
  return out;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * JUnit XML, which most CI systems render as test results. Failed undos are
 * failures, errors are errors, gated/skipped operations are skipped, and
 * inconclusive ones are skipped too (failures with `strict`).
 */
export function toJUnit(report: VerifyReport, options: { strict?: boolean } = {}): string {
  const seconds = (Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 1000 || 0;
  const s = report.summary;
  const failures = s.failed + (options.strict ? s.inconclusive : 0);
  const skipped = s.gated + s.skipped + (options.strict ? 0 : s.inconclusive);
  const suite = `undogen verify: ${report.spec.title} ${report.spec.version}`;
  const cases = report.results.map((r) => {
    const name = xml(`${r.operationId} (${r.method} ${r.path})`);
    const detail = [r.detail, ...r.diffs.map((d) => `${d.resource} ${d.path}: ${fmt(d.before)} -> ${fmt(d.after)}`)].join('\n');
    let body = '';
    if (r.outcome === 'failed' || (r.outcome === 'inconclusive' && options.strict)) body = `<failure message="${xml(r.detail)}">${xml(detail)}</failure>`;
    else if (r.outcome === 'error') body = `<error message="${xml(r.detail)}">${xml(detail)}</error>`;
    else if (r.outcome !== 'verified') body = `<skipped message="${xml(`${r.outcome}: ${r.detail}`)}"/>`;
    return `    <testcase classname="undogen.${xml(r.reversibility)}" name="${name}" time="0">${body}</testcase>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="undogen" tests="${s.total}" failures="${failures}" errors="${s.error}" skipped="${skipped}" time="${seconds}">`,
    `  <testsuite name="${xml(suite)}" tests="${s.total}" failures="${failures}" errors="${s.error}" skipped="${skipped}" time="${seconds}" timestamp="${report.startedAt}">`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

/**
 * SARIF 2.1.0 for code scanning UIs (GitHub code scanning annotates the spec
 * file at each failing operation).
 */
export function toSarif(report: VerifyReport, specUri: string, specText?: string): object {
  const lines = specText?.split('\n') ?? [];
  const lineOf = (r: VerifyReport['results'][number]) => {
    const id = r.operationId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const byId = lines.findIndex((l) => new RegExp(`["']?operationId["']?\\s*:\\s*["']?${id}["']?\\s*,?\\s*$`).test(l));
    if (byId >= 0) return byId + 1;
    const byPath = lines.findIndex((l) => l.includes(`${r.path}"`) || l.includes(`${r.path}:`) || l.includes(`${r.path}'`));
    return byPath >= 0 ? byPath + 1 : 1;
  };
  const rules = [
    { id: 'undo-failed', name: 'UndoFailed', shortDescription: { text: 'The compiled inverse did not restore the prior state' }, defaultConfiguration: { level: 'error' } },
    { id: 'undo-inconclusive', name: 'UndoInconclusive', shortDescription: { text: 'The operation changed nothing visible, so its inverse was not exercised' }, defaultConfiguration: { level: 'warning' } },
    { id: 'undo-error', name: 'UndoError', shortDescription: { text: 'undogen could not set up or run the operation' }, defaultConfiguration: { level: 'warning' } },
  ];
  const ruleFor: Partial<Record<Outcome, string>> = { failed: 'undo-failed', inconclusive: 'undo-inconclusive', error: 'undo-error' };
  const results = report.results
    .filter((r) => ruleFor[r.outcome])
    .map((r) => ({
      ruleId: ruleFor[r.outcome],
      level: r.outcome === 'failed' ? 'error' : 'warning',
      message: {
        text: [`${r.operationId} (${r.method} ${r.path}): ${r.detail}`, ...r.diffs.slice(0, 10).map((d) => `${d.resource} ${d.path}: ${fmt(d.before)} → ${fmt(d.after)}`)].join('\n'),
      },
      locations: [{ physicalLocation: { artifactLocation: { uri: specUri }, region: { startLine: lineOf(r) } } }],
      partialFingerprints: { operation: `${r.method} ${r.path}` },
    }));
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'undogen', version: report.tool.version, informationUri: 'https://github.com/anup2k13/undogen', rules } },
        results,
      },
    ],
  };
}

/** Keys whose values are never written to reports. */
const SECRET_KEY = /token|secret|password|passwd|api[-_]?key|authorization|cookie|session|credential|private[-_]?key/i;

/**
 * Remove sensitive data from a report before it is stored or shared.
 * Values under secret-looking keys are always masked; with `all`, every
 * value in the diffs is masked (only types and lengths remain), and
 * credentials in the base URL are dropped.
 */
export function redactReport(report: VerifyReport, options: { all?: boolean } = {}): VerifyReport {
  const mask = (v: unknown): unknown => {
    if (v === null || v === undefined || typeof v === 'boolean') return v;
    if (typeof v === 'string') return `‹redacted string(${v.length})›`;
    if (typeof v === 'number') return '‹redacted number›';
    if (Array.isArray(v)) return v.map(mask);
    if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mask(x)]));
    return '‹redacted›';
  };
  const scrub = (v: unknown, path: string): unknown => {
    const last = path.split(/[.[\]]/).filter(Boolean).at(-1) ?? '';
    if (SECRET_KEY.test(last)) return mask(v);
    if (options.all) return mask(v);
    if (Array.isArray(v)) return v.map((x, i) => scrub(x, `${path}[${i}]`));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, `${path}.${k}`)]));
    return v;
  };
  let baseUrl = report.baseUrl;
  try {
    const u = new URL(report.baseUrl);
    u.username = '';
    u.password = '';
    for (const k of [...u.searchParams.keys()]) if (SECRET_KEY.test(k) || options.all) u.searchParams.set(k, 'redacted');
    baseUrl = u.toString().replace(/\/$/, '');
  } catch {
    /* keep */
  }
  return {
    ...report,
    baseUrl,
    results: report.results.map((r) => ({
      ...r,
      diffs: r.diffs.map((d) => ({
        ...d,
        before: d.path === 'status' ? d.before : scrub(d.before, d.path),
        after: d.path === 'status' ? d.after : scrub(d.after, d.path),
      })),
    })),
  };
}
