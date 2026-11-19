import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze, lint, parseSpec } from '../src/index.js';

const ok = (props?: object) => ({ '201': { description: '', content: { 'application/json': { schema: { type: 'object', properties: props ?? {} } } } } });
const spec = parseSpec({
  openapi: '3.0.3',
  info: { title: 'Lintable', version: '1' },
  paths: {
    '/jobs': { post: { operationId: 'createJob', responses: ok({ ref: { type: 'string' } }) } },
    '/jobs/{jobId}': { delete: { operationId: 'deleteJob', responses: {} } },
    '/notes': { post: { operationId: 'createNote', responses: ok({ id: { type: 'string' } }) } },
    '/notes/{noteId}': {
      get: { operationId: 'getNote', responses: {} },
      patch: { responses: {} },
    },
    '/settings/{key}': { patch: { operationId: 'updateSetting', responses: {} } },
    '/widgets/{widgetId}/frobnicate': { post: { operationId: 'frobnicate', responses: {} } },
    '/emails': { post: { operationId: 'sendEmail', responses: {} } },
    '/orgs/{org}/repos/{repoId}': {
      put: { operationId: 'enableRepo', responses: {} },
      delete: { operationId: 'disableRepo', responses: {} },
    },
  },
});

describe('lint', () => {
  const findings = lint(spec, analyze(spec));
  const by = (rule: string) => findings.filter((f) => f.rule === rule).map((f) => f.operationId);

  it('turns structural gaps into concrete fixes, errors first', () => {
    expect(by('create-without-id')).toEqual(['createJob']);
    expect(findings.find((f) => f.rule === 'create-without-id')!.fix).toMatch(/identifier in the response .*"jobId".*Location header/);
    expect(by('create-without-delete')).toEqual(['createNote']);
    expect(findings.find((f) => f.rule === 'create-without-delete')!.fix).toContain('Add DELETE /notes/{noteId}');
    expect(by('write-without-get')).toEqual(['updateSetting']);
    expect(by('action-without-counterpart')).toEqual(['frobnicate']);
    expect(by('missing-operation-id')).toEqual(['PATCH /notes/{noteId}']);
    expect(by('external-effect')).toEqual(['sendEmail']);
    expect(findings[0]!.severity).toBe('error');
    expect(findings.at(-1)!.severity).toBe('info');
  });

  it('treats a DELETE/bodiless PUT membership route as a toggle, not a missing GET', () => {
    expect(by('delete-without-get')).toEqual(['deleteJob']); // a real gap; disableRepo is not flagged
    expect(analyze(spec).plans.find((p) => p.operationId === 'disableRepo')).toMatchObject({ strategy: 'toggle', inverse: { method: 'put' } });
  });

  it('says nothing about operations that are declared', () => {
    const declared = parseSpec({
      openapi: '3.0.3',
      info: { title: 'x', version: '1' },
      paths: { '/w/{id}/frob': { post: { operationId: 'frob', 'x-undogen': { reversibility: 'irreversible', reason: 'by design' }, responses: {} } } },
    });
    expect(lint(declared, analyze(declared))).toEqual([]);
  });
});

describe('cli: lint', () => {
  it('exits quietly when its output is piped into something that closes early', async () => {
    const root = new URL('..', import.meta.url).pathname;
    const child = spawn(join(root, 'node_modules/.bin/tsx'), [join(root, 'src/cli.ts'), 'analyze', join(root, 'examples/todo-api/openapi.yaml')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.once('data', () => child.stdout.destroy()); // like `| head -1`
    const code = await new Promise((r) => child.on('close', r));
    expect(stderr).not.toContain('EPIPE');
    expect(code).toBe(0);
  });
});
