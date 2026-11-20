/**
 * Consistency audit of compiled plans on public API descriptions: a strategy
 * that contradicts the operation's own name is a likely analyzer bug (that is
 * how POST …/pods/{name}/proxy, taken for a create, was found).
 *
 *   npx tsx scripts/audit-plans.ts [--cache .cache/specs] [--refresh]
 *
 * Exits 1 if anything is flagged or a spec could not be downloaded or loaded. Runs weekly in CI against the latest specs.
 */
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { analyze, loadSpec, tokenize, type InversePlan } from '../src/index.js';
import { ensureSpecs, specLocation, specName } from './public-specs.js';

const { values } = parseArgs({ options: { cache: { type: 'string', default: '.cache/specs' }, refresh: { type: 'boolean' } } });
const dir = resolve(new URL('..', import.meta.url).pathname, values.cache!);
const { entries: files, failed: notDownloaded } = await ensureSpecs(dir, values.refresh);

/** Words an operation name must contain (any one) for a strategy to be plausible. */
const EXPECT: Array<{ when: (p: InversePlan) => boolean; label: string; words: RegExp }> = [
  {
    when: (p) => p.strategy === 'delete-created' || p.strategy === 'soft-delete',
    label: 'treated as a create',
    words: /^(create|add|post|insert|new|upload|set|put|make|open|invite|enable|save|subscribe|follow|star|pin|attach|link|assign|store|write|register)$/,
  },
  {
    when: (p) => p.strategy === 'restore-snapshot' && p.method === 'post',
    label: 'POST treated as an update',
    words: /^(update|set|modify|edit|post|patch|change|save|configure|rename|replace|put)$/,
  },
];
/** Names that must never be classified as undoable. */
const NEVER_REVERSIBLE = /^(send|exec|execute|proxy|charge|pay|transfer|refund|dispatch|deliver|notify|broadcast)$/;

let flagged = 0;
let failedToLoad = notDownloaded.length;
for (const name of notDownloaded) console.log(`${name}: could not be downloaded, not audited`);
for (const entry of files) {
  const file = specName(entry);
  let spec;
  try {
    spec = await loadSpec(specLocation(dir, entry));
  } catch (err) {
    // One spec that can't be loaded shouldn't stop the audit of the others.
    console.log(`${file}: could not load: ${(err as Error).message}`);
    failedToLoad++;
    continue;
  }
  const analysis = analyze(spec); // an analyzer crash is a bug: let it fail the run as one
  for (const p of analysis.plans) {
    const words = tokenize(p.operationId.split('/').pop() ?? p.operationId);
    for (const e of EXPECT) {
      if (e.when(p) && !words.some((w) => e.words.test(w))) {
        flagged++;
        console.log(`${file}: ${p.operationId} (${p.method.toUpperCase()} ${p.path}) is ${e.label}, but its name doesn't say so`);
      }
    }
    if ((p.reversibility === 'reversible' || p.reversibility === 'compensable') && p.strategy !== 'declared' && words.some((w) => NEVER_REVERSIBLE.test(w))) {
      flagged++;
      console.log(`${file}: ${p.operationId} is ${p.reversibility} (${p.strategy}) but its name says it can't be called back`);
    }
  }
}
console.log(flagged ? `\n${flagged} plan(s) flagged` : 'No plan contradicts its operation name.');
if (failedToLoad) console.log(`${failedToLoad} spec(s) could not be loaded and were not audited`);
process.exitCode = flagged || failedToLoad ? 1 : 0;
