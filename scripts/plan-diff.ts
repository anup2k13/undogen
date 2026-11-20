/**
 * Compare the compiled plans of the working tree against a git ref, on the
 * public API descriptions from the benchmark. Use it on every analyzer change:
 * every plan that changes is listed, so false positives are found by reading.
 *
 *   npx tsx scripts/plan-diff.ts [--ref HEAD] [--cache .cache/specs] [--all]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ensureSpecs } from './public-specs.js';


const { values } = parseArgs({ options: { ref: { type: 'string', default: 'HEAD' }, cache: { type: 'string', default: '.cache/specs' }, all: { type: 'boolean' } } });
const root = resolve(new URL('..', import.meta.url).pathname);
const cache = resolve(root, values.cache!);
const { entries: files, failed: notDownloaded } = await ensureSpecs(cache);
for (const name of notDownloaded) console.log(`warning: ${name} could not be downloaded and is NOT compared in this run`);

/** Every plan field that matters, per "<api> <operationId>". */
const dumpScript = `
const [mod, helpers, cache, ...files] = process.argv.slice(2);
const { loadSpec, analyze } = await import(mod);
const { specLocation, specName } = await import(helpers);
const out = {};
for (const f of files) {
  const a = analyze(await loadSpec(specLocation(cache, f)), { restoreChildren: true });
  for (const p of a.plans) out[specName(f) + ' ' + p.operationId] = [p.reversibility, p.strategy, p.confidence, p.inverse, p.capture, p.check, p.checkMode, p.children, p.inverseIfMissing, p.identity];
}
process.stdout.write(JSON.stringify(out));
`;
const work = mkdtempSync(join(tmpdir(), 'undogen-plan-diff-'));
const script = join(work, 'dump.mts');
writeFileSync(script, dumpScript);
const tsx = join(root, 'node_modules/.bin/tsx');
const dump = (srcRoot: string) =>
  JSON.parse(execFileSync(tsx, [script, join(srcRoot, 'src/index.ts'), join(root, 'scripts/public-specs.ts'), cache, ...files], { maxBuffer: 1 << 28, encoding: 'utf8' })) as Record<string, unknown[]>;

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
