#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { analyze } from './analyze.js';
import { annotate, toArazzo, toBundle } from './export.js';
import { initFiles, mergeKeepingExisting } from './init.js';
import { learn } from './learn.js';
import { analysisToHtml, c, formatAnalysis, formatResultLine, formatSummary, redactReport, toBadge, toHtml, toJUnit, toMarkdown, toSarif } from './report.js';
import { FileJournalStore, UndoableClient } from './runtime.js';
import { loadSpec } from './spec.js';
import { describeEntry } from './tools.js';
import type { ApiSpec, Declaration } from './types.js';
import { DEFAULT_IGNORED_FIELDS, verify, type Fixtures, type VerifyReport } from './verify.js';
import { VERSION } from './version.js';

const HELP = `
${c.bold('undogen')} ${VERSION} — compile undo operations from an OpenAPI spec, then prove they work.

${c.bold('Usage')}
  undogen analyze  <spec> [--json | --html <file>] Derive an inverse for every write operation (no network)
  undogen verify   <spec> --base-url <url>         Run each operation and its inverse on a sandbox, diff the state
  undogen mcp      <spec> --base-url <url>         Serve the API as MCP tools with journaling and undo tools
  undogen wrap     [--journal <file>] -- <cmd...>  Put undo in front of another MCP server (experimental; --analyze, --undo)
  undogen undo     <spec> --base-url <url> --journal <file> [--seq n | --all | --session id]
  undogen journal  --journal <file> [--session id] [--json]  Show a persisted journal (--compact rewrites it smaller)
  undogen learn    <spec> --base-url <url> --out <overrides.json>   Find id bindings for unknown creates by experiment
  undogen init     <spec> [--from-report report.json]               Write starter overrides.json and fixtures.json
  undogen annotate <spec> [-o <file>]              Write x-undogen declarations and OpenAPI links into the spec
  undogen arazzo   <spec> [-o <file>]              Export undo workflows as an Arazzo 1.0 document
  undogen compile  <spec> [-o <file>]              Export operations + plans as JSON (for the Python client)
  undogen types    <spec> [-o <file>]              TypeScript interfaces for typed<Operations>(client)
  undogen diff     <old-spec> <new-spec>           Compare reversibility between two versions of an API
  undogen lint     <spec>                          What to change in the API so more of it can be undone

  <spec> is an OpenAPI 3.x or Swagger 2.0 file (JSON or YAML) or URL. External $refs are followed.

${c.bold('Common options')}
  --overrides <file>     JSON map of operationId -> declaration, for specs you don't control
  --restore-children     When undoing a delete re-creates a resource, re-create its child collections too
  --header <k:v>         Extra request header (repeatable), e.g. "authorization: Bearer $TOKEN"
  --only <id,id*,...>    Only these operationIds (a trailing * matches a prefix)
  --trust-refs           Let a spec loaded from a URL follow $refs to other hosts and local files
                         (by default only its own origin: their contents can end up in requests)

${c.bold('verify')}
  --fixtures <file>      Per-operation params, bodies, prepare steps, skips
  --ignore <a,b,...>     Extra fields that may legitimately differ (default: timestamps, etags)
  --report <dir>         Write report.json, report.md, report.html and badge.json to <dir>
  --junit <file>         Write JUnit XML          --sarif <file>   Write SARIF 2.1.0 (code scanning)
  --redact               Mask every value in written reports (secret-looking keys are always masked)
  --strict               Exit 1 on inconclusive results too
  --scoped-only          Only snapshot routes scoped to created resources (for shared sandboxes)
  --check-conflicts      Also prove that undo refuses to overwrite a concurrent change (doubles the requests)
  --keep                 Keep the resources verify created (default: delete them afterwards)
  --no-seed              Don't seed child resources (disables cascade detection)
  --concurrency <n>      Parallel GETs per snapshot (default 4)
  --max-pages <n>        Pages to follow (Link rel=next) for list routes (default 5)

${c.bold('mcp')}
  --journal <file>       Persist the journal (undo after restarts; blocks replays of irreversible calls)
  --irreversible <mode>  ask (default: ask the human via MCP elicitation), allow, or deny
  --no-reads             Don't expose GET operations as tools
  --tags <a,b>           Only operations with these OpenAPI tags
  --compact              Three tools (search, describe, call) instead of one per operation, for large APIs

${c.bold('diff')}
  --markdown             Print a Markdown summary (for pull request comments)
  --fail-on <what>       Exit 1 on: regressed (default), gated (also new irreversible/unknown writes), any, never

${c.bold('lint')}
  --fail-on <level>      Exit 1 on: error (default), warning, never
  --all                  List every operation per rule (default: the first 5)

${c.bold('undo')}
  --seq <n>              Undo this entry (default: the most recent one)    --all   Undo everything, newest first
  --after <n>            Undo everything after entry n (a checkpoint), newest first
  --session <id>         undo: everything one session (one agent run) did; journal: show only that session
  --force                Undo even if someone changed the data since       --cascade   Undo dependent entries first

Exit codes: 0 ok, 1 an inverse failed verification (or an undo failed), 2 usage or setup error.
`;

const OPTIONS = {
  json: { type: 'boolean' },
  'base-url': { type: 'string' },
  overrides: { type: 'string' },
  fixtures: { type: 'string' },
  ignore: { type: 'string' },
  only: { type: 'string' },
  header: { type: 'string', multiple: true },
  report: { type: 'string' },
  junit: { type: 'string' },
  sarif: { type: 'string' },
  redact: { type: 'boolean' },
  strict: { type: 'boolean' },
  'scoped-only': { type: 'boolean' },
  'check-conflicts': { type: 'boolean' },
  keep: { type: 'boolean' },
  'no-seed': { type: 'boolean' },
  concurrency: { type: 'string' },
  'max-pages': { type: 'string' },
  'restore-children': { type: 'boolean' },
  journal: { type: 'string' },
  irreversible: { type: 'string' },
  'no-reads': { type: 'boolean' },
  tags: { type: 'string' },
  seq: { type: 'string' },
  after: { type: 'string' },
  session: { type: 'string' },
  analyze: { type: 'boolean' },
  undo: { type: 'boolean' },
  all: { type: 'boolean' },
  force: { type: 'boolean' },
  cascade: { type: 'boolean' },
  out: { type: 'string', short: 'o' },
  'from-report': { type: 'string' },
  'fixtures-out': { type: 'string' },
  'overrides-out': { type: 'string' },
  'no-links': { type: 'boolean' },
  overwrite: { type: 'boolean' },
  'trust-refs': { type: 'boolean' },
  compact: { type: 'boolean' },
  markdown: { type: 'boolean' },
  html: { type: 'string' },
  'fail-on': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

class UsageError extends Error {}

const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
const list = (s: string | undefined) => s?.split(',').map((x) => x.trim()).filter(Boolean);

function headersOf(values: Values): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const h of values.header ?? []) {
    const i = h.indexOf(':');
    if (i < 1) throw new UsageError(`Bad --header "${h}", expected "name: value"`);
    headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  return headers;
}

function printWarnings(spec: ApiSpec) {
  if (!spec.warnings.length) return;
  console.error(c.yellow(`  ⚠ ${spec.warnings.length} spec warning(s):`));
  for (const w of spec.warnings.slice(0, 5)) console.error(c.dim(`    ${w}`));
  if (spec.warnings.length > 5) console.error(c.dim(`    … ${spec.warnings.length - 5} more (see analyze --json)`));
}

function printDiff(d: import('./diff.js').AnalysisDiff) {
  const s = d.summary;
  console.log(`\n${c.bold('undogen diff')}  ${c.dim('·')}  ${d.from.title} ${c.dim(d.from.version)} → ${c.dim(d.to.version)}\n`);
  const arrow = (x: { reversibility: string; inverse?: string }) => `${x.reversibility}${x.inverse ? c.dim(` (${x.inverse})`) : ''}`;
  for (const ch of d.changed) {
    const icon = ch.kind === 'regressed' ? c.red('▼') : ch.kind === 'improved' ? c.green('▲') : c.yellow('~');
    console.log(`  ${icon} ${ch.operationId.padEnd(32)} ${ch.method.padEnd(7)}${ch.path}`);
    console.log(`      ${arrow(ch.from)}  →  ${arrow(ch.to)}`);
    if (ch.kind !== 'improved') console.log(c.dim(`      ${ch.reason}`));
  }
  for (const p of d.added) {
    const gated = p.reversibility === 'irreversible' || p.reversibility === 'unknown';
    console.log(`  ${gated ? c.magenta('+') : c.green('+')} ${p.operationId.padEnd(32)} ${p.method.toUpperCase().padEnd(7)}${p.path}  ${c.dim(p.reversibility)}`);
  }
  for (const p of d.removed) console.log(c.dim(`  - ${p.operationId.padEnd(32)} ${p.method.toUpperCase().padEnd(7)}${p.path}`));
  if (!d.changed.length && !d.added.length && !d.removed.length) console.log(c.dim('  No changes to write operations.'));
  console.log(
    `\n  ${c.red(`${s.regressed} regressed`)} · ${c.green(`${s.improved} improved`)} · ${c.yellow(`${s.inverseChanged} inverse changed`)} · ${s.added} added (${s.addedGated} gated) · ${s.removed} removed\n`,
  );
}

async function write(file: string, text: string) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

function positiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} must be a whole number of at least 1`);
  return n;
}

function needBaseUrl(values: Values): string {
  const url = values['base-url'];
  if (!url) throw new UsageError('this command needs --base-url (use a sandbox: undogen creates and deletes data)');
  return url;
}

async function main(argv: string[]) {
  // `wrap` passes everything after `--` to the server it starts, untouched.
  const dashes = argv.indexOf('--');
  const own = dashes === -1 ? argv : argv.slice(0, dashes);
  const { values, positionals } = parseArgs({ args: own, allowPositionals: true, options: OPTIONS });
  if (values.version) return console.log(VERSION);
  const [command, specPath] = positionals;
  if (command === 'wrap' && !values.help) {
    if (positionals.length > 1) throw new UsageError(`wrap takes the server's command after --, e.g. undogen wrap -- ${positionals.slice(1).join(' ')}`);
    const { runWrap, WrapUsageError } = await import('./wrap/cli.js');
    try {
      process.exitCode = await runWrap(values, dashes === -1 ? [] : argv.slice(dashes + 1));
    } catch (err) {
      if (err instanceof WrapUsageError) throw new UsageError(err.message);
      throw err;
    }
    return;
  }
  if (dashes !== -1) throw new UsageError('-- is only used by wrap');
  if (values.help || !command) {
    console.log(HELP);
    return process.exit(command || values.help ? 0 : 2);
  }

  if (command === 'journal') {
    if (!values.journal) throw new UsageError('journal needs --journal <file>');
    if (values.compact) {
      const { before, after } = await new FileJournalStore(values.journal).compact();
      return console.log(`  ${values.journal}: ${before} lines -> ${after} entries`);
    }
    const all = await new FileJournalStore(values.journal).load();
    const entries = values.session ? all.filter((e) => e.session === values.session) : all;
    if (values.json) return console.log(JSON.stringify(entries, null, 2));
    if (!entries.length) return console.log(values.session ? `  (no entries for session ${values.session})` : '  (empty journal)');
    let session: string | undefined;
    for (const e of entries) {
      if (e.session !== session) {
        // One heading per session (one agent run), so `undo --session` has something to point at.
        session = e.session;
        const n = entries.filter((x) => x.session === session).length;
        console.log(c.bold(`  session ${session}`) + c.dim(`  ${e.at.replace('T', ' ').slice(0, 16)} UTC · ${n} write${n === 1 ? '' : 's'}`));
      }
      const d = describeEntry(e);
      const color = e.status === 'undone' ? c.dim : e.status === 'active' ? (s: string) => s : c.red;
      console.log(color(`  #${String(d.seq).padEnd(4)} ${d.status.padEnd(9)} ${d.operationId.padEnd(28)} ${d.request.padEnd(40)} ↺ ${d.undo ?? '(none)'}`));
      if (e.undoError) console.log(c.dim(`        ${e.undoError}`));
    }
    return;
  }

  if (command === 'diff') {
    const [, oldPath, newPath] = positionals;
    if (!oldPath || !newPath) throw new UsageError('diff needs <old-spec> <new-spec>');
    const failOn = values['fail-on'] ?? 'regressed';
    if (!['regressed', 'gated', 'any', 'never'].includes(failOn)) throw new UsageError('--fail-on must be regressed, gated, any or never');
    const overridesFor = values.overrides ? await readJson<Record<string, Declaration>>(values.overrides) : undefined;
    const analyzeLenient = (spec: ApiSpec) => {
      // An overrides file written for one version may mention operations the other lacks.
      const ids = new Set(spec.operations.map((o) => o.id));
      const own = overridesFor && Object.fromEntries(Object.entries(overridesFor).filter(([id]) => ids.has(id)));
      return analyze(spec, { overrides: own, restoreChildren: values['restore-children'] });
    };
    const { diffAnalyses, diffToMarkdown } = await import('./diff.js');
    const load = { trustRefs: values['trust-refs'] };
    const d = diffAnalyses(analyzeLenient(await loadSpec(oldPath, load)), analyzeLenient(await loadSpec(newPath, load)));
    if (values.json) console.log(JSON.stringify(d, null, 2));
    else if (values.markdown) console.log(diffToMarkdown(d));
    else printDiff(d);
    const s = d.summary;
    const fail =
      failOn === 'regressed' ? s.regressed > 0 :
      failOn === 'gated' ? s.regressed + s.addedGated > 0 :
      failOn === 'any' ? s.regressed + s.improved + s.inverseChanged + s.added + s.removed > 0 : false;
    if (fail) process.exitCode = 1;
    return;
  }

  if (!specPath) throw new UsageError(`${command} needs a <spec>. Try --help.`);
  const spec = await loadSpec(specPath, { trustRefs: values['trust-refs'] });
  const overrides = values.overrides ? await readJson<Record<string, Declaration>>(values.overrides) : undefined;
  const analysis = analyze(spec, { overrides, restoreChildren: values['restore-children'] });
  const headers = headersOf(values);
  const only = list(values.only);

  switch (command) {
    case 'analyze': {
      if (values.json) return console.log(JSON.stringify(analysis, null, 2));
      if (values.html) {
        await write(values.html, analysisToHtml(analysis));
        return console.log(`  ${analysis.plans.length} plans written to ${values.html}`);
      }
      console.log(formatAnalysis(analysis));
      printWarnings(spec);
      return;
    }

    case 'verify': {
      const baseUrl = needBaseUrl(values);
      const fixtures: Fixtures = values.fixtures ? await readJson(values.fixtures) : {};
      const matches = (id: string) => !only || only.some((p) => (p.endsWith('*') ? id.startsWith(p.slice(0, -1)) : id === p));
      const ops = spec.operations.filter((o) => o.method !== 'get' && matches(o.id));
      const idW = Math.max(12, ...ops.map((o) => o.id.length)) + 2;
      const pathW = Math.max(10, ...ops.map((o) => o.path.length)) + 2;

      console.log(`\n${c.bold('undogen verify')}  ${c.dim('·')}  ${spec.title} ${c.dim(spec.version)}  ${c.dim('·')}  ${baseUrl}\n`);
      printWarnings(spec);
      const raw = await verify({
        spec,
        baseUrl,
        plans: analysis.plans,
        fixtures,
        headers,
        seedChildren: !values['no-seed'],
        cleanup: !values.keep,
        scopedOnly: values['scoped-only'],
        checkConflicts: values['check-conflicts'],
        concurrency: positiveInt(values.concurrency, '--concurrency'),
        maxPages: positiveInt(values['max-pages'], '--max-pages'),
        ignoreFields: [...DEFAULT_IGNORED_FIELDS, ...(list(values.ignore) ?? [])],
        only: ops.map((o) => o.id),
        onResult: (r) => console.log(formatResultLine(r, idW, pathW)),
      });
      console.log(formatSummary(raw));
      const report = redactReport(raw, { all: values.redact });

      if (values.report) {
        await mkdir(values.report, { recursive: true });
        await writeFile(join(values.report, 'report.json'), JSON.stringify(report, null, 2));
        await writeFile(join(values.report, 'report.md'), toMarkdown(report));
        await writeFile(join(values.report, 'badge.json'), JSON.stringify(toBadge(report)));
        await writeFile(join(values.report, 'report.html'), toHtml(report));
        console.log(c.dim(`  Reports written to ${values.report}/`));
      }
      if (values.junit) {
        await write(values.junit, toJUnit(report, { strict: values.strict }));
        console.log(c.dim(`  JUnit written to ${values.junit}`));
      }
      if (values.sarif) {
        const local = !/^https?:/i.test(specPath);
        const specText = local ? await readFile(specPath, 'utf8') : undefined;
        const uri = local ? relative(process.cwd(), specPath).split('\\').join('/') : specPath;
        await write(values.sarif, JSON.stringify(toSarif(report, uri, specText), null, 2));
        console.log(c.dim(`  SARIF written to ${values.sarif}`));
      }
      if (values.report || values.junit || values.sarif) console.log('');
      if (report.summary.failed > 0 || (values.strict && report.summary.inconclusive > 0)) process.exitCode = 1;
      return;
    }

    case 'mcp': {
      const { createMcpServer } = await import('./mcp.js');
      const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
      const mode = values.irreversible ?? 'ask';
      if (!['ask', 'allow', 'deny'].includes(mode)) throw new UsageError('--irreversible must be ask, allow or deny');
      const { server } = await createMcpServer({
        spec,
        baseUrl: needBaseUrl(values),
        plans: analysis.plans,
        headers,
        store: values.journal ? new FileJournalStore(values.journal) : undefined,
        only,
        includeReads: !values['no-reads'],
        tags: list(values.tags),
        compact: values.compact,
        irreversible: mode as 'ask' | 'allow' | 'deny',
      });
      await server.connect(new StdioServerTransport());
      console.error(`undogen mcp: serving ${spec.title} ${spec.version} (${spec.operations.length} operations) over stdio`);
      return;
    }

    case 'undo': {
      if (!values.journal) throw new UsageError('undo needs --journal <file> (written by `undogen mcp --journal` or FileJournalStore)');
      if (!existsSync(values.journal)) throw new UsageError(`No journal at ${values.journal}`);
      const client = await UndoableClient.open({ spec, baseUrl: needBaseUrl(values), plans: analysis.plans, headers, store: new FileJournalStore(values.journal) });
      const opts = { force: values.force, cascade: values.cascade };
      if ([values.seq !== undefined, !!values.all, values.after !== undefined, values.session !== undefined].filter(Boolean).length > 1) {
        throw new UsageError('use one of --seq, --all, --after and --session');
      }
      if (values.all || values.after || values.session) {
        const after = values.after !== undefined ? Number(values.after) : undefined;
        if (after !== undefined && !Number.isInteger(after)) throw new UsageError('--after must be a number');
        if (values.session && !client.journal.some((e) => e.session === values.session)) {
          throw new UsageError(`No entries for session ${values.session} in ${values.journal} (see undogen journal)`);
        }
        const { undone, failed } = await client.undoAll({ ...opts, after, session: values.session });
        if (!undone.length && !failed.length) console.log('  nothing to undo');
        for (const e of undone) console.log(c.green(`  ↺ #${e.seq} ${e.operationId}  ${describeEntry(e).undo}`));
        for (const f of failed) console.log(c.red(`  ✗ #${f.entry.seq} ${f.entry.operationId}: ${f.error.message}`));
        if (failed.length) process.exitCode = 1;
        return;
      }
      const seq = values.seq ? Number(values.seq) : undefined;
      if (values.seq && !Number.isInteger(seq)) throw new UsageError('--seq must be a number');
      try {
        // Resolve the target first, the way undo() does, so we report the entry that was undone.
        const target = seq !== undefined ? client.journal.find((x) => x.seq === seq) : [...client.journal].reverse().find((x) => x.status !== 'undone');
        if (!target) {
          console.log(seq !== undefined ? c.red(`  ✗ No journal entry #${seq}`) : '  nothing to undo');
          if (seq !== undefined) process.exitCode = 1;
          return;
        }
        await client.undo(target, opts);
        console.log(c.green(`  ↺ #${target.seq} ${target.operationId}  ${describeEntry(target).undo}`));
      } catch (err) {
        console.log(c.red(`  ✗ ${(err as Error).message}`));
        process.exitCode = 1;
      }
      return;
    }

    case 'learn': {
      const out = values.out ?? values.overrides ?? 'overrides.json';
      const fixtures: Fixtures = values.fixtures ? await readJson(values.fixtures) : {};
      console.log(`\n${c.bold('undogen learn')}  ${c.dim('·')}  ${spec.title}  ${c.dim('·')}  ${needBaseUrl(values)}\n`);
      const { learned, attempts } = await learn({
        spec,
        baseUrl: needBaseUrl(values),
        plans: analysis.plans,
        fixtures,
        headers,
        only,
        onAttempt: (a) => {
          const icon = a.outcome === 'learned' ? c.green('✓') : a.outcome === 'error' ? c.yellow('!') : c.dim('–');
          console.log(`  ${icon} ${a.operationId.padEnd(32)} ${a.outcome === 'learned' ? a.detail : c.dim(a.detail)}`);
        },
      });
      if (!attempts.length) console.log(c.dim('  Nothing to learn: no unknown creates with a suspected inverse.'));
      const n = Object.keys(learned).length;
      if (n) {
        const existing = existsSync(out) ? await readJson<Record<string, Declaration>>(out) : {};
        await write(out, JSON.stringify({ ...existing, ...learned }, null, 2) + '\n');
        console.log(`\n  Learned ${n} binding(s) into ${out}. Prove them: undogen verify ${specPath} --overrides ${out} --base-url …\n`);
      } else console.log('');
      return;
    }

    case 'init': {
      const report = values['from-report'] ? await readJson<VerifyReport>(values['from-report']) : undefined;
      const { overrides: o, fixtures: f } = initFiles(spec, analysis, report);
      const oFile = values['overrides-out'] ?? 'overrides.json';
      const fFile = values['fixtures-out'] ?? 'fixtures.json';
      for (const [file, generated, label] of [[oFile, o, 'overrides'], [fFile, f, 'fixtures']] as const) {
        const existing = existsSync(file) ? await readJson<Record<string, object>>(file) : {};
        const merged = mergeKeepingExisting(generated as Record<string, object>, existing);
        const added = Object.keys(generated).filter((k) => !(k in existing)).length;
        await write(file, JSON.stringify(merged, null, 2) + '\n');
        console.log(`  ${file}: ${added} new ${label} entr${added === 1 ? 'y' : 'ies'}${Object.keys(existing).length ? ` (kept ${Object.keys(existing).length} existing)` : ''}`);
      }
      console.log(c.dim('  Keys starting with "_" are notes; undogen ignores them.'));
      return;
    }

    case 'annotate': {
      if (/^https?:/i.test(specPath)) throw new UsageError('annotate needs a local spec file');
      const text = annotate(await readFile(specPath, 'utf8'), analysis, { links: !values['no-links'], overwrite: values.overwrite });
      if (values.out) {
        await write(values.out, text);
        console.error(`  Annotated spec written to ${values.out}`);
      } else process.stdout.write(text);
      return;
    }

    case 'arazzo': {
      const text = toArazzo(spec, analysis, /^https?:/i.test(specPath) ? specPath : `./${relative(values.out ? dirname(values.out) : process.cwd(), specPath).split('\\').join('/')}`);
      if (values.out) await write(values.out, text);
      else process.stdout.write(text);
      return;
    }

    case 'lint': {
      const { lint } = await import('./lint.js');
      const findings = lint(spec, analysis);
      const failOn = values['fail-on'] ?? 'error';
      if (!['error', 'warning', 'never'].includes(failOn)) throw new UsageError('--fail-on must be error, warning or never');
      if (values.json) console.log(JSON.stringify(findings, null, 2));
      else {
        console.log(`\n${c.bold('undogen lint')}  ${c.dim('·')}  ${spec.title} ${c.dim(spec.version)}\n`);
        const groups = new Map<string, typeof findings>();
        for (const f of findings) groups.set(f.rule, [...(groups.get(f.rule) ?? []), f]);
        const color = { error: c.red, warning: c.yellow, info: c.dim };
        for (const [rule, list] of groups) {
          const first = list[0]!;
          console.log(`  ${color[first.severity](`${first.severity.padEnd(7)} ${rule}`)}  ${c.dim(`(${list.length})`)}`);
          for (const f of values.all ? list : list.slice(0, 5)) {
            console.log(`    ${f.operationId.padEnd(36)} ${f.method.padEnd(7)}${f.path}`);
            console.log(c.dim(`      → ${f.fix}`));
          }
          if (!values.all && list.length > 5) console.log(c.dim(`    … ${list.length - 5} more (--all)`));
          console.log('');
        }
        const n = (s: string) => findings.filter((f) => f.severity === s).length;
        console.log(`  ${c.red(`${n('error')} errors`)} · ${c.yellow(`${n('warning')} warnings`)} · ${c.dim(`${n('info')} info`)}\n`);
      }
      const errors = findings.filter((f) => f.severity === 'error').length;
      const warnings = findings.filter((f) => f.severity === 'warning').length;
      if ((failOn === 'error' && errors) || (failOn === 'warning' && errors + warnings)) process.exitCode = 1;
      return;
    }

    case 'types': {
      const { generateTypes } = await import('./typegen.js');
      const text = generateTypes(spec);
      if (values.out) await write(values.out, text);
      else process.stdout.write(text);
      return;
    }

    case 'compile': {
      const text = JSON.stringify(toBundle(spec, analysis, VERSION), null, 2) + '\n';
      if (values.out) await write(values.out, text);
      else process.stdout.write(text);
      return;
    }

    default:
      throw new UsageError(`Unknown command "${command}". Try --help.`);
  }
}

// `undogen lint | head` closes stdout early: stop quietly instead of crashing with EPIPE.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

main(process.argv.slice(2)).catch((err) => {
  console.error(c.red(`error: ${(err as Error).message}`));
  process.exit(2);
});
