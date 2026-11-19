import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify } from 'yaml';
import { analyze, diffAnalyses, diffToMarkdown, parseSpec } from '../src/index.js';

const root = new URL('..', import.meta.url).pathname;
const specPath = join(root, 'examples/todo-api/openapi.yaml');
let dir: string;
let oldDoc: any;
let newDoc: any;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'undogen-diff-'));
  oldDoc = parseYaml(await readFile(specPath, 'utf8'));
  newDoc = structuredClone(oldDoc);
  newDoc.info.version = '2.0.0';
  delete newDoc.paths['/todos/{todoId}/comments/{commentId}'].delete; // comments can no longer be deleted
  newDoc.paths['/todos/{todoId}/notify'] = { post: { operationId: 'notifyWatchers', responses: { '202': { description: 'queued' } } } };
  newDoc.paths['/todos/{todoId}'].get.operationId = 'fetchTodo'; // a rename is not a removal
  await writeFile(join(dir, 'v1.yaml'), stringify(oldDoc));
  await writeFile(join(dir, 'v2.yaml'), stringify(newDoc));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('diffAnalyses', () => {
  it('reports regressions, new gated writes and removals', () => {
    const d = diffAnalyses(analyze(parseSpec(oldDoc)), analyze(parseSpec(newDoc)));
    expect(d.changed).toEqual([
      expect.objectContaining({
        operationId: 'createComment',
        kind: 'regressed',
        from: expect.objectContaining({ reversibility: 'reversible', inverse: 'DELETE /todos/{todoId}/comments/{commentId}' }),
        to: expect.objectContaining({ reversibility: 'irreversible' }),
      }),
    ]);
    expect(d.added.map((p) => [p.operationId, p.reversibility])).toEqual([['notifyWatchers', 'irreversible']]);
    expect(d.removed.map((p) => p.operationId)).toEqual(['deleteComment']);
    expect(d.summary).toMatchObject({ regressed: 1, addedGated: 1, removed: 1, improved: 0 });
    expect(diffToMarkdown(d)).toContain('| `createComment` | `POST /todos/{todoId}/comments` | reversible (DELETE /todos/{todoId}/comments/{commentId}) | irreversible |');
  });

  it('reports nothing between identical versions', () => {
    const a = analyze(parseSpec(oldDoc));
    expect(diffAnalyses(a, a).summary).toEqual({ added: 0, addedGated: 0, removed: 0, regressed: 0, improved: 0, inverseChanged: 0 });
  });
});

describe('cli: diff', () => {
  const run = async (...args: string[]) => {
    try {
      const { stdout } = await promisify(execFile)(join(root, 'node_modules/.bin/tsx'), [join(root, 'src/cli.ts'), 'diff', ...args], { env: { ...process.env, NO_COLOR: '1' } });
      return { code: 0, stdout };
    } catch (e) {
      return { code: (e as { code: number }).code, stdout: (e as { stdout: string }).stdout };
    }
  };

  it('exits 1 on regressions by default and 0 in the other direction', async () => {
    const forward = await run(join(dir, 'v1.yaml'), join(dir, 'v2.yaml'));
    expect(forward.code).toBe(1);
    expect(forward.stdout).toContain('▼ createComment');
    expect(forward.stdout).toContain('1 regressed · 0 improved · 0 inverse changed · 1 added (1 gated) · 1 removed');
    expect((await run(join(dir, 'v2.yaml'), join(dir, 'v1.yaml'))).code).toBe(0);
  });

  it('honours --fail-on and prints Markdown', async () => {
    expect((await run(join(dir, 'v1.yaml'), join(dir, 'v2.yaml'), '--fail-on', 'never')).code).toBe(0);
    expect((await run(join(dir, 'v2.yaml'), join(dir, 'v1.yaml'), '--fail-on', 'any')).code).toBe(1);
    expect((await run(join(dir, 'v1.yaml'), join(dir, 'v2.yaml'), '--markdown', '--fail-on', 'never')).stdout).toContain('#### Regressed: harder to undo');
  });
});
