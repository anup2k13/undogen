/**
 * Run `analyze` over public API descriptions and print a markdown table.
 *
 *   npx tsx scripts/benchmark.ts [--out docs/benchmarks.md]
 *
 * Specs are fetched from their official repositories (pinned to a branch, so
 * numbers drift as the APIs evolve). The table records what the compiler
 * hypothesises; it says nothing about whether the inverses work. That's
 * what `undogen verify` is for, and it needs a sandbox per API.
 */
import { writeFile } from 'node:fs/promises';
import { analyze, loadSpec } from '../src/index.js';
import { VERSION } from '../src/version.js';

const SPECS: Array<{ name: string; url: string; note?: string }> = [
  { name: 'GitHub REST', url: 'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json' },
  { name: 'Stripe', url: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json', note: 'POST-for-update style' },
  { name: 'Twilio Api v2010', url: 'https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_api_v2010.json', note: 'form-encoded bodies' },
  { name: 'Asana', url: 'https://raw.githubusercontent.com/Asana/openapi/master/defs/asana_oas.yaml' },
  { name: 'DigitalOcean', url: 'https://raw.githubusercontent.com/digitalocean/openapi/main/specification/DigitalOcean-public.v2.yaml', note: 'hundreds of external $ref files' },
  { name: 'Slack Web', url: 'https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2.json', note: 'Swagger 2.0, RPC style' },
  { name: 'Kubernetes', url: 'https://raw.githubusercontent.com/kubernetes/kubernetes/master/api/openapi-spec/swagger.json', note: 'Swagger 2.0' },
];

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '–');

const rows: string[] = [];
for (const s of SPECS) {
  const t = Date.now();
  try {
    const spec = await loadSpec(s.url);
    const a = analyze(spec);
    const m = a.summary;
    const secs = ((Date.now() - t) / 1000).toFixed(1);
    rows.push(
      `| ${s.name} | ${spec.operations.length} | ${m.total} | ${m.reversible} | ${m.compensable} | ${m.irreversible} | ${m.unknown} | ${pct(m.reversible + m.compensable, m.total)} | ${spec.warnings.length} | ${secs}s | ${s.note ?? ''} |`,
    );
    console.error(`✓ ${s.name}: ${m.total} writes, ${secs}s`);
  } catch (err) {
    rows.push(`| ${s.name} | – | – | – | – | – | – | – | – | – | failed: ${(err as Error).message.slice(0, 80)} |`);
    console.error(`✗ ${s.name}: ${(err as Error).message}`);
  }
}

const out = [
  `# Benchmark: analyze on public API descriptions`,
  '',
  `undogen ${VERSION}, ${new Date().toISOString().slice(0, 10)}. Regenerate with \`npx tsx scripts/benchmark.ts --out docs/benchmarks.md\`.`,
  '',
  '| API | Operations | Writes | Reversible | Compensable | Irreversible (gated) | Unknown | Undo derived | Spec warnings | Time | Notes |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
  ...rows,
  '',
  '**Undo derived** is the share of write operations that get a compiled inverse with no hand-written code. ',
  'These are hypotheses: only `undogen verify` against a sandbox shows whether an inverse works. ',
  'The confidence scores in each plan are heuristic and not calibrated; calibrating them needs verify results across many APIs.',
  '',
].join('\n');

const outIdx = process.argv.indexOf('--out');
if (outIdx > 0) await writeFile(process.argv[outIdx + 1]!, out);
else console.log(out);
