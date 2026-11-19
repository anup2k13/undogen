#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { analyze } from './analyze.js';
import { c, formatAnalysis, formatResultLine, formatSummary, toBadge, toMarkdown } from './report.js';
import { loadSpec } from './spec.js';
import { DEFAULT_IGNORED_FIELDS, verify, type Fixtures } from './verify.js';

const HELP = `
${c.bold('undogen')} — compile undo operations from an OpenAPI spec, then prove they work.

${c.bold('Usage')}
  undogen analyze <spec> [--json] [--overrides <file>]
  undogen verify  <spec> --base-url <url> [options]

  <spec> is an OpenAPI 3.x file (JSON or YAML) or URL.
  --overrides <file>     JSON map of operationId -> declaration, for specs you don't control

${c.bold('analyze')}   Derive an inverse for every write operation (no network calls).
  --json                 Print the compiled plans as JSON

${c.bold('verify')}    Run each operation and its inverse against a test server, diff the state.
  --base-url <url>       Server to test against. Use a sandbox — verify creates and deletes data.
  --fixtures <file>      JSON fixtures: per-operation params, bodies, prepare steps, skips
  --ignore <a,b,...>     Extra fields that may legitimately differ (default: timestamps, etags)
  --only <id,id,...>     Only verify these operationIds
  --header <k:v>         Extra request header (repeatable), e.g. "authorization: Bearer $TOKEN"
  --report <dir>         Write report.json, report.md and badge.json to <dir>
  --no-seed              Don't seed child resources (disables cascade detection)

Exit code is 1 when any inverse fails verification.
`;

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
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.version) return console.log('0.1.0');
  const [command, specPath] = positionals;
  if (values.help || !command || !specPath) {
    console.log(HELP);
    return process.exit(command ? 0 : 1);
  }

  const spec = await loadSpec(specPath);
  const overrides = values.overrides ? JSON.parse(await readFile(values.overrides, 'utf8')) : undefined;
  const analysis = analyze(spec, { overrides });

  if (command === 'analyze') {
    console.log(values.json ? JSON.stringify(analysis, null, 2) : formatAnalysis(analysis));
    return;
  }

  if (command === 'verify') {
    const baseUrl = values['base-url'];
    if (!baseUrl) throw new Error('verify needs --base-url');
    const fixtures: Fixtures = values.fixtures ? JSON.parse(await readFile(values.fixtures, 'utf8')) : {};
    const headers: Record<string, string> = {};
    for (const h of values.header ?? []) {
      const i = h.indexOf(':');
      if (i < 1) throw new Error(`Bad --header "${h}", expected "name: value"`);
      headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
    }
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
