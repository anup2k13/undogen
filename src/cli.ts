#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { analyze } from './analyze.js';
import { readJournal } from './journal.js';
import { c, formatAnalysis, formatJournal, formatResultLine, formatSummary, toBadge, toMarkdown } from './report.js';
import { UndoableClient, UndoConflictError } from './runtime.js';
import { loadSpec } from './spec.js';
import { VERSION } from './version.js';
import { DEFAULT_IGNORED_FIELDS, verify, type Fixtures } from './verify.js';

const HELP = `
${c.bold('undogen')} ${c.dim(VERSION)} — compile undo operations from an OpenAPI spec, then prove they work.

${c.bold('Usage')}
  undogen analyze <spec> [--json] [--overrides <file>]
  undogen init    <spec> [--base-url <url>] [--out <file>] [--force]
  undogen verify  <spec> --base-url <url> [options]
  undogen mcp     <spec> --base-url <url> [--journal <file>] [--header <k:v>] [--allow-irreversible]
  undogen journal <file>
  undogen undo    --journal <file> --base-url <url> [--seq <n> | --all] [--force] [--header <k:v>]

  <spec> is an OpenAPI 3.x file (JSON or YAML) or URL.
  --overrides <file>     JSON map of operationId -> declaration, for specs you don't control
  --header <k:v>         Extra request header (repeatable), e.g. "authorization: Bearer $TOKEN"

${c.bold('analyze')}   Derive an inverse for every write operation (no network calls).
  --json                 Print the compiled plans as JSON

${c.bold('init')}      Generate a fixtures file for verify: example bodies, prepare steps.
  --base-url <url>       Also probe a sandbox to check and refine the fixtures
  --out <file>           Where to write them (default: undogen.fixtures.json)
  --force                Overwrite an existing file

${c.bold('verify')}    Run each operation and its inverse against a test server, diff the state.
  --base-url <url>       Server to test against. Use a sandbox — verify creates and deletes data.
  --fixtures <file>      JSON fixtures: per-operation params, bodies, prepare steps, skips
  --ignore <a,b,...>     Extra fields that may legitimately differ (default: timestamps, etags)
  --only <id,id,...>     Only verify these operationIds
  --report <dir>         Write report.json, report.md and badge.json to <dir>
  --no-seed              Don't seed child resources (disables cascade detection)
  Exit code is 1 when any inverse fails verification.

${c.bold('mcp')}       Serve the API as MCP tools over stdio, with every write journaled and undoable.

${c.bold('journal')}   Show what a journal recorded: each write, its inverse, and whether it was undone.

${c.bold('undo')}      Roll back writes recorded in a journal (default: the most recent one).
  --seq <n>              Undo a specific entry
  --all                  Undo every entry, newest first
  --force                Undo even if the resource changed after the write
`;

function parseHeaders(list: string[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const h of list ?? []) {
    const i = h.indexOf(':');
    if (i < 1) throw new Error(`Bad --header "${h}", expected "name: value"`);
    headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  return headers;
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      'base-url': { type: 'string' },
      overrides: { type: 'string' },
      fixtures: { type: 'string' },
      ignore: { type: 'string' },
      only: { type: 'string' },
      header: { type: 'string', multiple: true },
      report: { type: 'string' },
      'no-seed': { type: 'boolean' },
      journal: { type: 'string' },
      seq: { type: 'string' },
      all: { type: 'boolean' },
      force: { type: 'boolean' },
      'allow-irreversible': { type: 'boolean' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.version) return console.log(VERSION);
  const [command, target] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return process.exit(command || values.help ? 0 : 1);
  }
  const headers = parseHeaders(values.header);

  if (command === 'journal') {
    const file = target ?? values.journal;
    if (!file) throw new Error('journal needs a file: undogen journal <file>');
    console.log(formatJournal(await readJournal(file), file));
    return;
  }

  if (command === 'undo') {
    const journalFile = values.journal ?? target;
    const baseUrl = values['base-url'];
    if (!journalFile || !baseUrl) throw new Error('undo needs --journal <file> and --base-url <url>');
    const client = await UndoableClient.open({ baseUrl, headers, journalFile });
    const force = !!values.force;
    if (values.all) {
      const { undone, failed } = await client.undoAll({ force });
      for (const e of undone) console.log(`  ${c.green('↺')} #${e.seq} ${e.operationId}  ${c.dim(`${e.inverse?.method.toUpperCase() ?? ''} ${e.inverse?.path ?? ''}`)}`);
      for (const { entry, error } of failed) console.log(`  ${c.red('✗')} #${entry.seq} ${entry.operationId}  ${c.red(error.message)}`);
      console.log(`\n  ${c.green(`${undone.length} undone`)} · ${failed.length ? c.red(`${failed.length} failed`) : '0 failed'}\n`);
      if (failed.length) process.exitCode = 1;
      return;
    }
    const seq = values.seq !== undefined ? Number(values.seq) : undefined;
    try {
      const res = await client.undo(seq, { force });
      const entry = seq !== undefined ? client.journal.find((e) => e.seq === seq)! : [...client.journal].reverse().find((e) => e.undone)!;
      console.log(`  ${c.green('↺')} #${entry.seq} ${entry.operationId} undone  ${c.dim(`HTTP ${res.status}`)}`);
    } catch (err) {
      if (err instanceof UndoConflictError) {
        console.error(c.yellow(`  ⚠ ${err.message}`));
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    return;
  }

  if (!target) {
    console.log(HELP);
    return process.exit(1);
  }
  const spec = await loadSpec(target);
  const overrides = values.overrides ? JSON.parse(await readFile(values.overrides, 'utf8')) : undefined;
  const analysis = analyze(spec, { overrides });

  if (command === 'analyze') {
    console.log(values.json ? JSON.stringify(analysis, null, 2) : formatAnalysis(analysis));
    return;
  }

  if (command === 'init') {
    const out = values.out ?? 'undogen.fixtures.json';
    if (!values.force) {
      const exists = await readFile(out).then(() => true, () => false);
      if (exists) throw new Error(`${out} already exists. Use --force to overwrite, or --out to pick another file.`);
    }
    const { generateFixtures } = await import('./init.js');
    console.log(`\n${c.bold('undogen init')}  ${c.dim('·')}  ${spec.title} ${c.dim(spec.version)}${values['base-url'] ? `  ${c.dim('·')}  probing ${values['base-url']}` : ''}\n`);
    const result = await generateFixtures({
      spec,
      plans: analysis.plans,
      baseUrl: values['base-url'],
      headers,
      onProgress: (m) => console.log(c.dim(`  · ${m}`)),
    });
    await writeFile(out, JSON.stringify(result.fixtures, null, 2) + '\n');
    const n = Object.keys(result.fixtures).length;
    console.log(`  ${c.green('✓')} wrote ${n} fixture${n === 1 ? '' : 's'} to ${out}`);
    if (result.report) console.log(formatSummary(result.report).trimEnd());
    for (const t of result.todo) console.log(`  ${c.yellow('!')} ${t.operationId}: ${t.reason}`);
    console.log(
      result.report
        ? `\n  Next: ${c.bold(`undogen verify ${target} --base-url ${values['base-url']} --fixtures ${out}`)}\n`
        : `\n  Next: review ${out}, then run ${c.bold(`undogen init ${target} --base-url <sandbox> --force`)} to check it against a server.\n`,
    );
    return;
  }

  if (command === 'mcp') {
    const baseUrl = values['base-url'];
    if (!baseUrl) throw new Error('mcp needs --base-url');
    const { serveStdio } = await import('./mcp.js');
    await serveStdio({
      spec,
      plans: analysis.plans,
      baseUrl,
      headers,
      journalFile: values.journal,
      allowIrreversible: !!values['allow-irreversible'],
    });
    return;
  }

  if (command === 'verify') {
    const baseUrl = values['base-url'];
    if (!baseUrl) throw new Error('verify needs --base-url');
    const fixtures: Fixtures = values.fixtures ? JSON.parse(await readFile(values.fixtures, 'utf8')) : {};
    const ops = spec.operations.filter((o) => o.method !== 'get');
    const idW = Math.max(12, ...ops.map((o) => o.id.length)) + 2;
    const pathW = Math.max(10, ...ops.map((o) => o.path.length)) + 2;

    console.log(`\n${c.bold('undogen verify')}  ${c.dim('·')}  ${spec.title} ${c.dim(spec.version)}  ${c.dim('·')}  ${baseUrl}\n`);
    const report = await verify({
      spec,
      baseUrl,
      plans: analysis.plans,
      fixtures,
      headers,
      seedChildren: !values['no-seed'],
      ignoreFields: [...DEFAULT_IGNORED_FIELDS, ...(values.ignore?.split(',').map((s) => s.trim()) ?? [])],
      only: values.only?.split(',').map((s) => s.trim()),
      onResult: (r) => console.log(formatResultLine(r, idW, pathW)),
    });
    console.log(formatSummary(report));

    if (values.report) {
      await mkdir(values.report, { recursive: true });
      await writeFile(join(values.report, 'report.json'), JSON.stringify(report, null, 2));
      await writeFile(join(values.report, 'report.md'), toMarkdown(report));
      await writeFile(join(values.report, 'badge.json'), JSON.stringify(toBadge(report)));
      console.log(c.dim(`  Reports written to ${values.report}/\n`));
    }
    if (report.summary.failed > 0) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown command "${command}". Try --help.`);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(c.red(`error: ${(err as Error).message}`));
  process.exit(2);
});
