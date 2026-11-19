import { describe, expect, it } from 'vitest';
import { loadSpec, parseSpec, UndoableClient } from '../src/index.js';
import { describeCall } from '../src/mcp.js';
import { refusedRef } from '../src/spec.js';
import { toolDefinitions } from '../src/tools.js';

describe('path parameters cannot climb to another route', () => {
  const spec = parseSpec({
    openapi: '3.0.3',
    info: { title: 'x', version: '1' },
    paths: {
      '/projects/{projectId}': { delete: { operationId: 'deleteProject', responses: {} } },
      '/projects/{projectId}/members/{userId}': {
        get: { operationId: 'getMember', responses: {} },
        delete: { operationId: 'removeMember', responses: {} },
        put: { operationId: 'addMember', responses: {} },
      },
    },
  });

  it('refuses ".." / "." / empty values before any request is sent', async () => {
    const sent: string[] = [];
    const f: typeof fetch = async (u, init) => (sent.push(`${init?.method} ${String(u)}`), new Response('{}'));
    const client = new UndoableClient({ spec, baseUrl: 'https://api.example', fetch: f });
    const [tool] = toolDefinitions(client, spec.operations, { only: ['removeMember'], includeReads: false, undoTools: false });
    for (const bad of ['..', '.', '']) {
      await expect(tool!.execute({ projectId: 'p1', userId: bad })).rejects.toThrow(/must not be/);
    }
    expect(sent).toEqual([]);
    await tool!.execute({ projectId: 'p1', userId: 'u..1' }); // dots inside a value are fine
    expect(sent.at(-1)).toBe('DELETE https://api.example/projects/p1/members/u..1');
  });
});

describe('external $refs from a remote spec', () => {
  const remote = {
    openapi: '3.0.3',
    info: { title: 'Remote', version: '1' },
    paths: {
      '/things': {
        post: {
          operationId: 'createThing',
          requestBody: { content: { 'application/json': { schema: { $ref: 'schemas.json#/Thing' }, example: { $ref: 'file:///etc/hostname' } } } },
          responses: {},
        },
      },
    },
  };
  const fetched: string[] = [];
  const f: typeof fetch = async (u) => {
    fetched.push(String(u));
    if (String(u).endsWith('/openapi.json')) return new Response(JSON.stringify(remote));
    if (String(u).endsWith('/schemas.json')) return new Response(JSON.stringify({ Thing: { type: 'object', properties: { name: { type: 'string' } } } }));
    return new Response('nope', { status: 404 });
  };

  it('follows same-origin refs but never reads local files', async () => {
    const spec = await loadSpec('https://vendor.example/api/openapi.json', { fetch: f });
    const op = spec.operations[0]!;
    expect(op.requestSchema!.properties).toEqual({ name: { type: 'string' } });
    expect(op.requestExample).toEqual({});
    expect(spec.warnings).toContain('External $ref file:///etc/hostname was not loaded: a spec loaded from a URL may not read local files');
    expect(fetched).toEqual(['https://vendor.example/api/openapi.json', 'https://vendor.example/api/schemas.json']);
  });

  it('decides by scheme and origin', () => {
    expect(refusedRef('http://169.254.169.254/latest', 'https://vendor.example/openapi.json')).toMatch(/same origin/);
    expect(refusedRef('https://vendor.example/x.json', 'https://vendor.example/openapi.json')).toBeUndefined();
    expect(refusedRef('file:///home/me/schemas.yaml', 'file:///home/me/openapi.yaml')).toBeUndefined(); // the user's own files
    expect(refusedRef('file:///etc/passwd', 'https://vendor.example/openapi.json', true)).toBeUndefined(); // --trust-refs
  });
});

describe('credentials stay the configured ones', () => {
  it('ignores reserved header parameters and lets configured headers win in any case', async () => {
    const spec = parseSpec({
      swagger: '2.0',
      info: { title: 'x', version: '1' },
      paths: {
        '/docs': {
          post: {
            operationId: 'createDoc',
            parameters: [
              { name: 'Authorization', in: 'header', type: 'string', required: true },
              { name: 'X-Tenant', in: 'header', type: 'string' },
            ],
            responses: {},
          },
        },
      },
    });
    expect(spec.operations[0]!.headerParams.map((h) => h.name)).toEqual(['X-Tenant']);
    const seen: Array<Record<string, string>> = [];
    const f: typeof fetch = async (_u, init) => (seen.push(init!.headers as Record<string, string>), new Response('{}'));
    const client = new UndoableClient({ spec, baseUrl: 'http://x', fetch: f, headers: { authorization: 'Bearer configured' }, allowIrreversible: true });
    await client.request('post', '/docs', { headers: { Authorization: 'Bearer attacker', 'X-Tenant': 't1' } });
    expect(seen[0]).toEqual({ accept: 'application/json', 'X-Tenant': 't1', authorization: 'Bearer configured' });
  });
});

describe('approval prompts show the concrete call', () => {
  it('resolves the path, shows the query and a masked, truncated body', () => {
    const op = parseSpec({ openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: { '/repos/{owner}/{repo}': { delete: { operationId: 'deleteRepo', responses: {} } } } }).operations[0]!;
    expect(describeCall(op, { params: { owner: 'acme', repo: 'prod' }, query: { force: true }, body: { reason: 'cleanup', api_key: 'sk_live_1' } })).toBe(
      'DELETE /repos/acme/prod?force=true with body {"reason":"cleanup","api_key":"‹hidden›"}',
    );
    expect(describeCall(op, { params: { owner: 'acme', repo: '..' } })).toMatch(/must not be/);
    expect(describeCall(op, { params: { owner: 'a', repo: 'b' }, body: { text: 'x'.repeat(1000) } }).length).toBeLessThan(450);
  });
});
