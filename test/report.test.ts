import { describe, expect, it } from 'vitest';
import { analyze, formatAnalysis, formatResultLine, formatSummary, loadSpec, redactReport, toJUnit, toMarkdown, toSarif, type VerifyReport } from '../src/index.js';

const base: VerifyReport = {
  tool: { name: 'undogen', version: '0.0.0' },
  spec: { title: 'T', version: '1' },
  baseUrl: 'https://user:pass@sandbox.example.com/api?api_key=abc&region=eu',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:02.500Z',
  results: [
    { operationId: 'createThing', method: 'POST', path: '/things', reversibility: 'reversible', strategy: 'delete-created', outcome: 'verified', detail: 'state restored exactly', diffs: [] },
    {
      operationId: 'updateThing',
      method: 'PATCH',
      path: '/things/{id}',
      reversibility: 'reversible',
      strategy: 'restore-snapshot',
      outcome: 'failed',
      detail: '2 difference(s) remain after undo',
      diffs: [
        { resource: 'GET /things/{id}', path: '$.name', before: 'Ann <ann@example.com>', after: 'x' },
        { resource: 'GET /things/{id}', path: '$.apiToken', before: 'sk_live_123', after: 'sk_live_456' },
        { resource: 'GET /things/{id}', path: 'status', before: 200, after: 404 },
      ],
    },
    { operationId: 'noop', method: 'PUT', path: '/things/{id}/flag', reversibility: 'reversible', strategy: 'toggle', outcome: 'inconclusive', detail: 'nothing changed', diffs: [] },
    { operationId: 'send', method: 'POST', path: '/things/{id}/send', reversibility: 'irreversible', strategy: 'none', outcome: 'gated', detail: 'never executed', diffs: [] },
    { operationId: 'boom', method: 'DELETE', path: '/things/{id}', reversibility: 'compensable', strategy: 'recreate-from-snapshot', outcome: 'error', detail: 'setup <failed> & "quoted"', diffs: [] },
  ],
  summary: { verified: 1, failed: 1, inconclusive: 1, gated: 1, skipped: 0, error: 1, total: 5 },
};

describe('redactReport', () => {
  it('always masks secret-looking keys and drops credentials from the base URL', () => {
    const r = redactReport(base);
    const diffs = r.results[1]!.diffs;
    expect(diffs[0]!.before).toBe('Ann <ann@example.com>'); // not secret-looking: kept without --redact
    expect(diffs[1]).toMatchObject({ before: '‹redacted string(11)›', after: '‹redacted string(11)›' });
    expect(diffs[2]).toMatchObject({ before: 200, after: 404 }); // statuses are never masked
    expect(r.baseUrl).toBe('https://sandbox.example.com/api?api_key=redacted&region=eu');
  });

  it('masks every value with all, keeping only types and lengths', () => {
    const r = redactReport(base, { all: true });
    expect(r.results[1]!.diffs[0]!.before).toBe('‹redacted string(21)›');
    expect(r.baseUrl).toBe('https://sandbox.example.com/api?api_key=redacted&region=redacted');
    expect(base.results[1]!.diffs[0]!.before).toBe('Ann <ann@example.com>'); // the input is not mutated
  });

  it('masks nested secrets inside objects', () => {
    const nested = { ...base, results: [{ ...base.results[1]!, diffs: [{ resource: 'GET /x', path: '$[0]', before: { name: 'a', password: 'hunter2', auth: { Authorization: 'Bearer t' } }, after: undefined }] }] };
    expect(redactReport(nested).results[0]!.diffs[0]!.before).toEqual({ name: 'a', password: '‹redacted string(7)›', auth: { Authorization: '‹redacted string(8)›' } });
  });
});

describe('toJUnit', () => {
  it('maps outcomes to failures, errors and skips, and escapes XML', () => {
    const x = toJUnit(base);
    expect(x).toContain('tests="5" failures="1" errors="1" skipped="2" time="2.5"');
    expect(x).toContain('<error message="setup &lt;failed&gt; &amp; &quot;quoted&quot;">');
    expect(x).toContain('<skipped message="inconclusive: nothing changed"/>');
    expect(x).toContain('GET /things/{id} $.name: &quot;Ann &lt;ann@example.com&gt;&quot; -&gt; &quot;x&quot;');
  });

  it('counts inconclusive as a failure with strict', () => {
    expect(toJUnit(base, { strict: true })).toContain('failures="2" errors="1" skipped="1"');
  });
});

describe('toSarif', () => {
  it('points each finding at its operation in the spec', () => {
    const spec = ['openapi: 3.0.3', 'paths:', '  /things/{id}:', '    patch:', '      operationId: updateThing', '    delete:', '      operationId: boom'].join('\n');
    const sarif = toSarif(base, 'openapi.yaml', spec) as { runs: Array<{ results: Array<{ ruleId: string; level: string; locations: Array<{ physicalLocation: { region: { startLine: number } } }> }> }> };
    const results = sarif.runs[0]!.results;
    expect(results.map((r) => [r.ruleId, r.level, r.locations[0]!.physicalLocation.region.startLine])).toEqual([
      ['undo-failed', 'error', 5],
      ['undo-inconclusive', 'warning', 1],
      ['undo-error', 'warning', 7],
    ]);
  });
});

describe('terminal and markdown output', () => {
  it('formats results, summaries and markdown', () => {
    expect(formatResultLine(base.results[1]!)).toContain('$.name');
    expect(formatSummary(base)).toContain('1 inconclusive');
    const md = toMarkdown(base);
    expect(md).toContain('| ❌ | `updateThing` |');
    expect(md).toContain('## State left behind by failed undos');
  });

  it('formats an analysis, with caveats and the summary line', async () => {
    const a = analyze(await loadSpec(new URL('../examples/todo-api/openapi.yaml', import.meta.url).pathname));
    const out = formatAnalysis(a);
    expect(out).toContain('createTodo');
    expect(out).toContain('↺ undo     DELETE /todos/{todoId}  todoId ← response.id');
    expect(out).toContain('6 reversible');
  });
});
