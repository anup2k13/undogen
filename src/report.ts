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

/** Mask a value, keeping only its type and length. */
function mask(v: unknown): unknown {
  if (v === null || v === undefined || typeof v === 'boolean') return v;
  if (typeof v === 'string') return `‹redacted string(${v.length})›`;
  if (typeof v === 'number') return '‹redacted number›';
  if (Array.isArray(v)) return v.map(mask);
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mask(x)]));
  return '‹redacted›';
}

/** Mask values under secret-looking keys (with `all`, every value), at any depth. */
function scrubValue(v: unknown, path: string, all: boolean): unknown {
  const last = path.split(/[.[\]]/).filter(Boolean).at(-1) ?? '';
  if (SECRET_KEY.test(last) || all) return mask(v);
  if (Array.isArray(v)) return v.map((x, i) => scrubValue(x, `${path}[${i}]`, all));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubValue(x, `${path}.${k}`, all)]));
  return v;
}

/** Where the JSON value opening at `start` closes (string-aware), or -1 if the text ends first. */
function closingBracket(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') if (--depth === 0) return i;
  }
  return -1;
}

/**
 * Scrub response bodies quoted in free text (a detail like `HTTP 400 {...}`):
 * secret-looking keys are masked at any depth, and with `all` every body is.
 * Bodies cut short by `...` are handled too: from the first secret-looking
 * key (with `all`, from the opening bracket) to the end of the text is masked.
 */
function scrubText(text: string, all: boolean): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch !== '{' && ch !== '[') {
      out += ch;
      i++;
      continue;
    }
    const end = closingBracket(text, i);
    if (end !== -1) {
      const span = text.slice(i, end + 1);
      let parsed: unknown;
      let ok = true;
      try {
        parsed = JSON.parse(span);
      } catch {
        ok = false;
      }
      if (ok && parsed !== null && typeof parsed === 'object') {
        out += all ? '‹redacted›' : JSON.stringify(scrubValue(parsed, '', false));
        i = end + 1;
        continue;
      }
      out += ch; // prose in brackets, like "[2 resources]"
      i++;
      continue;
    }
    const rest = text.slice(i);
    if (!/^[{[]\s*["{[\d-]/.test(rest)) {
      out += ch;
      i++;
      continue;
    }
    // A body cut short: nothing after the first secret-looking key can be trusted to be safe.
    if (all) return out + '‹redacted›';
    const secret = /"([^"\\]{1,64})"\s*:/g;
    let m: RegExpExecArray | null;
    while ((m = secret.exec(rest))) {
      if (SECRET_KEY.test(m[1]!)) return out + rest.slice(0, m.index + m[0].length) + '"‹redacted›"';
    }
    return out + rest;
  }
  return out;
}

/**
 * Remove sensitive data from a report before it is stored or shared.
 * Values under secret-looking keys are always masked; with `all`, every
 * value in the diffs is masked (only types and lengths remain), and
 * credentials in the base URL are dropped.
 */
export function redactReport(report: VerifyReport, options: { all?: boolean } = {}): VerifyReport {
  const scrub = (v: unknown, path: string) => scrubValue(v, path, !!options.all);
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
      // Details can quote response bodies (e.g. a 400 error): scrub them too.
      detail: scrubText(r.detail, !!options.all),
      ...(r.conflictCheck ? { conflictCheck: { ...r.conflictCheck, detail: scrubText(r.conflictCheck.detail, !!options.all) } } : {}),
      diffs: r.diffs.map((d) => ({
        ...d,
        before: d.path === 'status' ? d.before : scrub(d.before, d.path),
        after: d.path === 'status' ? d.after : scrub(d.after, d.path),
      })),
    })),
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A self-contained HTML report (no external assets), e.g. to attach to a CI run.
 * Every value is escaped; diffs of failed operations are expanded.
 */
export function toHtml(report: VerifyReport): string {
  const s = report.summary;
  const label: Record<Outcome, string> = { verified: 'Verified', failed: 'Failed', inconclusive: 'Inconclusive', gated: 'Gated', skipped: 'Skipped', error: 'Error' };
  const tiles = (['verified', 'failed', 'inconclusive', 'gated', 'error', 'skipped'] as Outcome[])
    .map((o) => `<div class="tile ${o}"><div class="n">${s[o]}</div><div class="l">${label[o]}</div></div>`)
    .join('');
  const rows = report.results
    .map((r) => {
      const diffs = r.diffs.length
        ? `<details${r.outcome === 'failed' ? ' open' : ''}><summary>${r.diffs.length} difference(s)</summary><div class="diffwrap"><table class="diffs"><thead><tr><th>Resource</th><th>Path</th><th>Before</th><th>After undo</th></tr></thead><tbody>${r.diffs
            .map((d) => `<tr><td><code>${esc(d.resource)}</code></td><td><code>${esc(d.path)}</code></td><td><code class="before">${esc(fmt(d.before))}</code></td><td><code class="after">${esc(fmt(d.after))}</code></td></tr>`)
            .join('')}</tbody></table></div></details>`
        : '';
      return `<tr class="${r.outcome}"><td data-label="Result"><span class="badge ${r.outcome}">${label[r.outcome]}</span></td><td data-label="Operation"><code class="id">${esc(r.operationId)}</code></td><td data-label="Route"><code>${esc(`${r.method} ${r.path}`)}</code></td><td data-label="Class">${esc(r.reversibility)}</td><td data-label="Detail">${esc(r.detail)}${diffs}</td></tr>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reversibility report: ${esc(report.spec.title)}</title>
<style>
:root { --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --card: #f6f8fa;
  --ok: #1a7f37; --bad: #cf222e; --warn: #9a6700; --gate: #8250df; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --card: #151b23;
  --ok: #3fb950; --bad: #f85149; --warn: #d29922; --gate: #ab7df8; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; }
.meta { color: var(--muted); margin: 0 0 20px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin-bottom: 24px; }
.tile { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.tile .n { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
.tile .l { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.tile.verified .n { color: var(--ok); } .tile.failed .n, .tile.error .n { color: var(--bad); }
.tile.inconclusive .n { color: var(--warn); } .tile.gated .n { color: var(--gate); }
.scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--line); }
th { font-size: 12px; color: var(--muted); font-weight: 600; background: var(--card); }
tr:last-child > td { border-bottom: 0; }
code { font: 12.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
code.id { overflow-wrap: normal; white-space: nowrap; }
.diffwrap { overflow-x: auto; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid currentColor; white-space: nowrap; }
.badge.verified { color: var(--ok); } .badge.failed, .badge.error { color: var(--bad); }
.badge.inconclusive { color: var(--warn); } .badge.gated { color: var(--gate); } .badge.skipped { color: var(--muted); }
details { margin-top: 6px; } summary { cursor: pointer; color: var(--muted); }
table.diffs { margin-top: 6px; border: 1px solid var(--line); border-radius: 6px; }
table.diffs td, table.diffs th { padding: 4px 8px; }
.before { color: var(--ok); } .after { color: var(--bad); }
footer { color: var(--muted); margin-top: 16px; font-size: 12px; }
@media (max-width: 720px) {
  .results, .results > tbody { display: block; }
  .results > thead { display: none; }
  .results > tbody > tr { display: block; padding: 10px 12px; border-bottom: 1px solid var(--line); }
  .results > tbody > tr:last-child { border-bottom: 0; }
  .results > tbody > tr > td { display: block; border: 0; padding: 2px 0; }
  .results > tbody > tr > td[data-label]:not(:first-child)::before { content: attr(data-label); display: block; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin-top: 6px; }
  code.id { white-space: normal; overflow-wrap: anywhere; }
  table.diffs { min-width: 520px; }
}
</style>
</head>
<body>
<main>
<h1>Reversibility report: ${esc(report.spec.title)} ${esc(report.spec.version)}</h1>
<p class="meta">undogen ${esc(report.tool.version)} against <code>${esc(report.baseUrl)}</code> · ${esc(report.finishedAt)}</p>
<div class="tiles">${tiles}</div>
<div class="scroll"><table class="results">
<thead><tr><th>Result</th><th>Operation</th><th>Route</th><th>Class</th><th>Detail</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
<footer>An inverse is verified only when the state after the operation and its undo is equivalent to the state before. Gated operations are never executed.</footer>
</main>
</body>
</html>
`;
}

/**
 * A self-contained page for browsing compiled plans: summary, filters by class,
 * free-text search, and each plan's undo request, capture and caveats.
 * Plans are embedded as JSON (with "<" escaped, so spec text can't close the script).
 */
export function analysisToHtml(a: Analysis): string {
  const rows = a.plans.map((p) => ({
    id: p.operationId,
    route: `${p.method.toUpperCase()} ${p.path}`,
    cls: p.reversibility,
    strategy: p.strategy,
    confidence: p.confidence,
    undo: p.inverse ? describeTemplate(p.inverse) : '',
    capture: p.capture ? describeTemplate(p.capture) : '',
    ifNew: p.inverseIfMissing ? describeTemplate(p.inverseIfMissing) : '',
    reasons: p.reasons,
    caveats: p.caveats,
  }));
  const data = JSON.stringify({ title: `${a.spec.title} ${a.spec.version}`, summary: a.summary, rows }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Undo plans: ${esc(a.spec.title)}</title>
<style>
:root { --bg: #fff; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --card: #f6f8fa;
  --reversible: #1a7f37; --compensable: #0969da; --irreversible: #cf222e; --unknown: #9a6700; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --card: #151b23;
  --reversible: #3fb950; --compensable: #58a6ff; --irreversible: #f85149; --unknown: #d29922; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 16px; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
input[type=search] { flex: 1 1 240px; min-width: 0; padding: 7px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); font: inherit; }
button { padding: 6px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--card); color: var(--fg); font: inherit; cursor: pointer; }
button[aria-pressed=true] { border-color: currentColor; font-weight: 600; }
button.reversible { color: var(--reversible); } button.compensable { color: var(--compensable); }
button.irreversible { color: var(--irreversible); } button.unknown { color: var(--unknown); }
.count { color: var(--muted); margin: 0 0 8px; }
.plan { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; overflow-wrap: anywhere; }
.head { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
.cls { font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.cls.reversible { color: var(--reversible); } .cls.compensable { color: var(--compensable); }
.cls.irreversible { color: var(--irreversible); } .cls.unknown { color: var(--unknown); }
code { font: 12.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.meta { color: var(--muted); font-size: 12px; }
.line { margin-top: 4px; }
.line b { color: var(--muted); font-weight: 600; font-size: 12px; display: inline-block; min-width: 64px; }
.caveat { color: var(--unknown); font-size: 13px; }
</style>
</head>
<body>
<main>
<h1></h1>
<div class="controls">
  <input type="search" placeholder="Search operations, routes, reasons…" aria-label="Search">
  <button data-cls="all" aria-pressed="true">All</button>
  <button data-cls="reversible" class="reversible" aria-pressed="false"></button>
  <button data-cls="compensable" class="compensable" aria-pressed="false"></button>
  <button data-cls="irreversible" class="irreversible" aria-pressed="false"></button>
  <button data-cls="unknown" class="unknown" aria-pressed="false"></button>
</div>
<p class="count"></p>
<div id="plans"></div>
</main>
<script id="data" type="application/json">${data}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
document.querySelector('h1').textContent = 'Undo plans: ' + D.title;
for (const b of document.querySelectorAll('button[data-cls]')) {
  const c = b.dataset.cls;
  if (c !== 'all') b.textContent = c + ' (' + D.summary[c] + ')';
}
let cls = 'all';
const q = document.querySelector('input');
const list = document.getElementById('plans');
const el = (tag, cl, text) => { const e = document.createElement(tag); if (cl) e.className = cl; if (text !== undefined) e.textContent = text; return e; };
function render() {
  const needle = q.value.trim().toLowerCase();
  const rows = D.rows.filter((r) => (cls === 'all' || r.cls === cls) && (!needle || JSON.stringify(r).toLowerCase().includes(needle)));
  document.querySelector('.count').textContent = rows.length + ' of ' + D.rows.length + ' write operations';
  list.replaceChildren(...rows.slice(0, 500).map((r) => {
    const card = el('div', 'plan');
    const head = el('div', 'head');
    head.append(el('code', '', r.id), el('code', 'meta', r.route), el('span', 'cls ' + r.cls, r.cls), el('span', 'meta', r.strategy + ' · ' + r.confidence.toFixed(2)));
    card.append(head);
    const line = (label, text) => { if (!text) return; const l = el('div', 'line'); l.append(el('b', '', label), el('code', '', text)); card.append(l); };
    line('capture', r.capture); line('undo', r.undo); line('if new', r.ifNew);
    if (!r.undo && r.reasons[0]) card.append(el('div', 'line meta', r.reasons[0]));
    for (const c of r.caveats) card.append(el('div', 'line caveat', '⚠ ' + c));
    return card;
  }));
}
q.addEventListener('input', render);
for (const b of document.querySelectorAll('button[data-cls]')) b.addEventListener('click', () => {
  cls = b.dataset.cls;
  for (const x of document.querySelectorAll('button[data-cls]')) x.setAttribute('aria-pressed', String(x === b));
  render();
});
render();
</script>
</body>
</html>
`;
}
