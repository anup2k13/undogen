/**
 * Compare the compiled plans of the working tree against a git ref, on the
 * public API descriptions from the benchmark. Use it on every analyzer change:
 * every plan that changes is listed, so false positives are found by reading.
 *
 *   npx tsx scripts/plan-diff.ts [--ref HEAD] [--cache .cache/specs] [--all]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const SPECS: Record<string, string> = {
  github: 'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json',
  stripe: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json',
  twilio: 'https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_api_v2010.json',
  asana: 'https://raw.githubusercontent.com/Asana/openapi/master/defs/asana_oas.yaml',
  slack: 'https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2.json',
  kubernetes: 'https://raw.githubusercontent.com/kubernetes/kubernetes/master/api/openapi-spec/swagger.json',
};

const { values } = parseArgs({ options: { ref: { type: 'string', default: 'HEAD' }, cache: { type: 'string', default: '.cache/specs' }, all: { type: 'boolean' } } });
const root = resolve(new URL('..', import.meta.url).pathname);
const cache = resolve(root, values.cache!);
mkdirSync(cache, { recursive: true });
for (const [name, url] of Object.entries(SPECS)) {
  const file = join(cache, name + (url.endsWith('.yaml') ? '.yaml' : '.json'));
  if (existsSync(file)) continue;
  console.error(`downloading ${name}…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(file, await res.text());
}

/** Every plan field that matters, per "<api> <operationId>". */
const dumpScript = `
const [mod, cache, ...files] = process.argv.slice(2);
const { loadSpec, analyze } = await import(mod);
const out = {};
for (const f of files) {
  const a = analyze(await loadSpec(cache + '/' + f), { restoreChildren: true });
  for (const p of a.plans) out[f.split('.')[0] + ' ' + p.operationId] = [p.reversibility, p.strategy, p.confidence, p.inverse, p.capture, p.check, p.checkMode, p.children, p.inverseIfMissing, p.identity];
}
process.stdout.write(JSON.stringify(out));
`;
const files = Object.entries(SPECS).map(([n, u]) => n + (u.endsWith('.yaml') ? '.yaml' : '.json'));
const work = mkdtempSync(join(tmpdir(), 'undogen-plan-diff-'));
const script = join(work, 'dump.mts');
writeFileSync(script, dumpScript);
const tsx = join(root, 'node_modules/.bin/tsx');
const dump = (srcRoot: string) =>
  JSON.parse(execFileSync(tsx, [script, join(srcRoot, 'src/index.ts'), cache, ...files], { maxBuffer: 1 << 28, encoding: 'utf8' })) as Record<string, unknown[]>;

const base = join(work, 'base');
execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', base, values.ref!], { stdio: 'ignore' });
try {
  symlinkSync(join(root, 'node_modules'), join(base, 'node_modules'));
  const before = dump(base);
  const after = dump(root);
  const changed = Object.keys({ ...before, ...after }).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  const byApi: Record<string, number> = {};
  for (const k of changed) byApi[k.split(' ')[0]!] = (byApi[k.split(' ')[0]!] ?? 0) + 1;
  console.log(`${changed.length} plan(s) changed vs ${values.ref}${changed.length ? ': ' + JSON.stringify(byApi) : ''}`);
  const describe = (p: unknown[] | undefined) => {
    if (!p) return '(absent)';
    const inv = p[3] as { method: string; path: string } | undefined;
    return `${p[0]}/${p[1]}${inv ? ` ${inv.method.toUpperCase()} ${inv.path}` : ''}`;
  };
  for (const k of values.all ? changed : changed.slice(0, 60)) console.log(`  ${k}\n    ${describe(before[k])}\n  → ${describe(after[k])}`);
  if (!values.all && changed.length > 60) console.log(`  … ${changed.length - 60} more (--all)`);
} finally {
  execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', base], { stdio: 'ignore' });
  rmSync(work, { recursive: true, force: true });
}
