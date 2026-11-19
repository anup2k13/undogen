import { describe, expect, it } from 'vitest';
import { analyze, loadSpec, parseSpec, tokenize } from '../src/index.js';

const specPath = new URL('../examples/todo-api/openapi.yaml', import.meta.url).pathname;

describe('analyze: todo demo spec', async () => {
  const analysis = analyze(await loadSpec(specPath));
  const byId = Object.fromEntries(analysis.plans.map((p) => [p.operationId, p]));

  it('only plans write operations', () => {
    expect(analysis.summary.total).toBe(9);
    expect(analysis.summary.readOnly).toBe(4);
  });

  it('undoes a create by deleting the created id from the response', () => {
    const p = byId.createTodo!;
    expect(p.strategy).toBe('delete-created');
    expect(p.inverse).toMatchObject({ method: 'delete', path: '/todos/{todoId}' });
    expect(p.inverse!.bindings.todoId).toEqual({ from: 'response', key: 'id' });
  });

  it('handles nested collections, binding parent ids from the original params', () => {
    const p = byId.createComment!;
    expect(p.inverse!.bindings).toEqual({
      todoId: { from: 'params', key: 'todoId' },
      commentId: { from: 'response', key: 'id' },
    });
  });

  it('snapshots before PATCH and writes back only the keys that were sent', () => {
    const p = byId.updateTodo!;
    expect(p.strategy).toBe('restore-snapshot');
    expect(p.capture).toMatchObject({ method: 'get', path: '/todos/{todoId}' });
    expect(p.inverse!.body).toEqual({ from: 'before-request-keys' });
    expect(p.inverseIfMissing).toBeUndefined();
  });

  it('restores writable fields after PUT and deletes if the PUT created the resource', () => {
    const p = byId.replaceTodo!;
    expect(p.inverse!.body).toEqual({ from: 'before', fields: ['title', 'done'] });
    expect(p.inverseIfMissing).toMatchObject({ method: 'delete' });
  });

  it('treats DELETE as compensable: re-create from snapshot, excluding readOnly fields', () => {
    const p = byId.deleteTodo!;
    expect(p.reversibility).toBe('compensable');
    expect(p.inverse).toMatchObject({ method: 'post', path: '/todos', body: { from: 'before', fields: ['title', 'done'] } });
  });

  it('pairs archive/unarchive action endpoints', () => {
    expect(byId.archiveTodo!.inverse!.operationId).toBe('unarchiveTodo');
    expect(byId.unarchiveTodo!.inverse!.operationId).toBe('archiveTodo');
  });

  it('flags side effects that leave the system as irreversible', () => {
    expect(byId.sendReminder!.reversibility).toBe('irreversible');
    expect(byId.sendReminder!.inverse).toBeUndefined();
  });
});

describe('analyze: other API shapes', () => {
  const spec = parseSpec({
    openapi: '3.0.3',
    info: { title: 'Shapes', version: '1' },
    paths: {
      '/repos/{owner}/{repo}/star': {
        put: { operationId: 'starRepo', responses: { '204': { description: '' } } },
        delete: { operationId: 'unstarRepo', responses: { '204': { description: '' } } },
      },
      '/payments': {
        post: { operationId: 'chargeCard', responses: { '201': { description: '' } } },
      },
      '/payments/{paymentId}': {
        get: { operationId: 'getPayment', responses: { '200': { description: '' } } },
      },
      '/widgets': {
        post: {
          operationId: 'createWidget',
          responses: {
            '201': {
              description: '',
              content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: { widgetId: { type: 'string' } } } } } } },
            },
          },
        },
      },
      '/widgets/{widgetId}': {
        delete: { operationId: 'deleteWidget', responses: { '204': { description: '' } } },
      },
      '/widgets/{widgetId}/frobnicate': {
        post: { operationId: 'frobnicate', responses: { '200': { description: '' } } },
      },
      '/widgets/{widgetId}/explode': {
        post: {
          operationId: 'explodeWidget',
          'x-undogen': { reversibility: 'irreversible', reason: 'It explodes' },
          responses: { '200': { description: '' } },
        },
      },
      '/widgets/{widgetId}/hide': {
        post: { operationId: 'hideWidget', 'x-undogen': { inverse: 'frobnicate' }, responses: { '200': { description: '' } } },
      },
    },
  });
  const byId = Object.fromEntries(analyze(spec).plans.map((p) => [p.operationId, p]));

  it('treats PUT/DELETE on the same action route as a toggle (GitHub-style star)', () => {
    expect(byId.starRepo).toMatchObject({ strategy: 'toggle', inverse: { method: 'delete', path: '/repos/{owner}/{repo}/star' } });
    expect(byId.unstarRepo).toMatchObject({ strategy: 'toggle', inverse: { method: 'put' } });
  });

  it('marks a create without a delete endpoint as irreversible', () => {
    expect(byId.chargeCard!.reversibility).toBe('irreversible');
  });

  it('finds ids inside a response envelope', () => {
    expect(byId.createWidget!.inverse!.bindings.widgetId).toEqual({ from: 'response', key: 'data.widgetId' });
    expect(byId.createWidget!.confidence).toBeGreaterThan(0.8);
  });

  it('marks DELETE without a way to read the resource first as irreversible', () => {
    expect(byId.deleteWidget!.reversibility).toBe('irreversible');
  });

  it('reports unknown actions instead of guessing', () => {
    expect(byId.frobnicate!.reversibility).toBe('unknown');
  });

  it('honours x-undogen declarations', () => {
    expect(byId.explodeWidget).toMatchObject({ reversibility: 'irreversible', strategy: 'declared', reasons: ['It explodes'] });
    expect(byId.hideWidget).toMatchObject({ strategy: 'declared', inverse: { operationId: 'frobnicate' } });
  });
});

describe('tokenize', () => {
  it('splits camelCase, kebab-case and snake_case', () => {
    expect(tokenize('sendReminder')).toEqual(['send', 'reminder']);
    expect(tokenize('send-reminder')).toEqual(['send', 'reminder']);
    expect(tokenize('bulk_send_v2')).toEqual(['bulk', 'send', 'v2']);
  });
});

describe('analyze: GitHub-shaped APIs', () => {
  const ok = (schema?: object) => ({ '201': { description: '', ...(schema ? { content: { 'application/json': { schema } } } : {}) } });
  const spec = parseSpec({
    openapi: '3.0.3',
    info: { title: 'GitHub-ish', version: '1' },
    paths: {
      '/repos/{owner}/{repo}/issues': {
        post: { operationId: 'issues/create', responses: ok({ type: 'object', properties: { id: { type: 'integer' }, number: { type: 'integer' } } }) },
      },
      '/repos/{owner}/{repo}/issues/{issue_number}': {
        get: { operationId: 'issues/get', responses: ok() },
        patch: {
          operationId: 'issues/update',
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { state: { type: 'string', enum: ['open', 'closed'] } } } } } },
          responses: ok(),
        },
      },
      '/repos/{owner}/{repo}/issues/{issue_number}/comments': {
        post: { operationId: 'issues/create-comment', responses: ok({ type: 'object', properties: { id: { type: 'integer' } } }) },
      },
      '/repos/{owner}/{repo}/comments/{comment_id}': {
        delete: { operationId: 'repos/delete-commit-comment', responses: { '204': { description: '' } } },
      },
      '/repos/{owner}/{repo}/issues/comments/{comment_id}': {
        delete: { operationId: 'issues/delete-comment', responses: { '204': { description: '' } } },
      },
      '/repos/{owner}/{repo}/issues/{issue_number}/labels': {
        post: { operationId: 'issues/add-labels', responses: ok({ type: 'array', items: { type: 'object' } }) },
      },
      '/repos/{owner}/{repo}/issues/{issue_number}/labels/{name}': {
        delete: { operationId: 'issues/remove-label', responses: { '200': { description: '' } } },
      },
      '/orgs/{org}/actions/permissions': {
        get: { operationId: 'actions/get-permissions', responses: ok() },
        put: { operationId: 'actions/set-permissions', responses: { '204': { description: '' } } },
      },
      '/repos/{owner}/{repo}/dispatches': {
        post: { operationId: 'repos/create-dispatch-event', responses: { '204': { description: '' } } },
      },
      '/markdown': {
        post: { operationId: 'markdown/render', responses: { '200': { description: '' } } },
      },
      '/user/repos': {
        post: { operationId: 'repos/create-for-authenticated-user', responses: ok() },
      },
      '/repos/{owner}/{repo}': {
        delete: { operationId: 'repos/delete', responses: { '204': { description: '' } } },
      },
    },
  });
  const byId = Object.fromEntries(
    analyze(spec, {
      overrides: {
        'repos/create-for-authenticated-user': {
          inverse: 'repos/delete',
          bindings: { owner: 'response.owner.login', repo: 'response.name' },
        },
      },
    }).plans.map((p) => [p.operationId, p]),
  );

  it('compensates creates without DELETE by soft-deleting via a state enum', () => {
    expect(byId['issues/create']).toMatchObject({
      reversibility: 'compensable',
      strategy: 'soft-delete',
      inverse: { method: 'patch', body: { from: 'literal', value: { state: 'closed' } } },
    });
  });

  it('binds issue_number to response.number, not response.id', () => {
    expect(byId['issues/create']!.inverse!.bindings.issue_number).toEqual({ from: 'response', key: 'number' });
  });

  it('follows flat item routes and prefers the most specific one', () => {
    expect(byId['issues/create-comment']!.inverse).toMatchObject({
      operationId: 'issues/delete-comment',
      path: '/repos/{owner}/{repo}/issues/comments/{comment_id}',
    });
  });

  it('refuses to guess which item a list-returning create made', () => {
    expect(byId['issues/add-labels']!.reversibility).toBe('unknown');
  });

  it('snapshots and restores singleton settings', () => {
    expect(byId['actions/set-permissions']).toMatchObject({ strategy: 'restore-snapshot', capture: { path: '/orgs/{org}/actions/permissions' } });
  });

  it('uses namespaced operationIds and plural nouns to spot irreversible and pure operations', () => {
    expect(byId['repos/create-dispatch-event']!.reversibility).toBe('irreversible');
    expect(byId['markdown/render']).toMatchObject({ reversibility: 'reversible', strategy: 'no-side-effects' });
  });

  it('applies overrides with response bindings for specs you do not control', () => {
    expect(byId['repos/create-for-authenticated-user']!.inverse!.bindings).toEqual({
      owner: { from: 'response', key: 'owner.login' },
      repo: { from: 'response', key: 'name' },
    });
  });

  it('rejects overrides for unknown operations', () => {
    expect(() => analyze(spec, { overrides: { nope: { reversibility: 'irreversible' } } })).toThrow(/unknown operationId "nope"/);
  });
});

describe('analyze: irreversible effects hidden in names and summaries', () => {
  const ok = { '201': { description: '', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } };
  const spec = parseSpec({
    openapi: '3.0.3',
    info: { title: 'Billing', version: '1' },
    paths: {
      '/invoices': { post: { operationId: 'createAndSendInvoice', responses: ok } },
      '/drafts': { post: { operationId: 'createDraft', summary: 'Creates a draft and emails it to the customer', responses: ok } },
      '/notes': { post: { operationId: 'createNote', summary: 'Creates a note without notifying anyone', description: 'Watchers are notified by email.', responses: ok } },
      '/users/{userId}/email': {
        get: { operationId: 'getUserEmail', responses: { '200': { description: '' } } },
        patch: { operationId: 'updateUserEmail', responses: { '200': { description: '' } } },
      },
      '/invoices/{invoiceId}': { delete: { operationId: 'deleteInvoice', responses: { '204': { description: '' } } } },
      '/drafts/{draftId}': { delete: { operationId: 'deleteDraft', responses: { '204': { description: '' } } } },
      '/notes/{noteId}': { delete: { operationId: 'deleteNote', responses: { '204': { description: '' } } } },
    },
  });
  const byId = Object.fromEntries(analyze(spec).plans.map((p) => [p.operationId, p]));

  it('finds a strong verb anywhere in the operationId', () => {
    expect(byId.createAndSendInvoice!.reversibility).toBe('irreversible');
  });

  it('reads the summary', () => {
    expect(byId.createDraft!.reversibility).toBe('irreversible');
  });

  it('respects negations in the summary and only warns about the description', () => {
    expect(byId.createNote!.reversibility).toBe('reversible');
    expect(byId.createNote!.caveats.join(' ')).toContain('description mentions "notified"');
  });

  it('does not treat nouns like "email" as irreversible outside the leading verb', () => {
    expect(byId.updateUserEmail!.reversibility).toBe('reversible');
  });
});

describe('analyze: runtime support fields', async () => {
  const todo = await loadSpec(specPath);
  const plain = Object.fromEntries(analyze(todo).plans.map((p) => [p.operationId, p]));
  const withChildren = Object.fromEntries(analyze(todo, { restoreChildren: true }).plans.map((p) => [p.operationId, p]));

  it('adds a check GET to snapshot restores and creates', () => {
    expect(plain.updateTodo!.check).toMatchObject({ method: 'get', path: '/todos/{todoId}' });
    expect(plain.createTodo!.check).toMatchObject({ method: 'get', path: '/todos/{todoId}', bindings: { todoId: { from: 'response', key: 'id' } } });
    expect(plain.archiveTodo!.check).toBeUndefined();
  });

  it('records where a re-created resource reports its new id', () => {
    expect(plain.deleteTodo!.identity).toEqual({ param: 'todoId', responseKey: 'id' });
  });

  it('plans child re-creation only when asked', () => {
    expect(plain.deleteTodo!.children).toBeUndefined();
    expect(withChildren.deleteTodo!.children).toEqual([
      expect.objectContaining({ param: 'commentId', idKey: 'id', list: expect.objectContaining({ operationId: 'listComments' }) }),
    ]);
  });

  it('suggests the inverse for unknown creates, for `undogen learn`', () => {
    const spec = parseSpec({
      openapi: '3.0.3',
      info: { title: 'x', version: '1' },
      paths: {
        '/jobs': { post: { operationId: 'createJob', responses: { '201': { description: '', content: { 'application/json': { schema: { type: 'object', properties: { ref: { type: 'string' } } } } } } } } },
        '/jobs/{jobId}': { delete: { operationId: 'deleteJob', responses: { '204': { description: '' } } } },
      },
    });
    expect(analyze(spec).plans[0]).toMatchObject({ reversibility: 'unknown', suggestion: { inverse: 'deleteJob', param: 'jobId' } });
  });

  it('accepts "location" bindings and before-request-keys bodies in declarations', () => {
    const spec = parseSpec({
      openapi: '3.0.3',
      info: { title: 'x', version: '1' },
      paths: {
        '/jobs': { post: { operationId: 'createJob', 'x-undogen': { inverse: 'deleteJob', bindings: { jobId: 'location' } }, responses: { '201': { description: '' } } } },
        '/jobs/{jobId}': {
          get: { operationId: 'getJob', responses: { '200': { description: '' } } },
          delete: { operationId: 'deleteJob', responses: { '204': { description: '' } } },
          patch: { operationId: 'patchJob', 'x-undogen': { inverse: 'patchJob', body: 'before-request-keys' }, responses: { '200': { description: '' } } },
        },
      },
    });
    const byId = Object.fromEntries(analyze(spec).plans.map((p) => [p.operationId, p]));
    expect(byId.createJob!.inverse!.bindings.jobId).toEqual({ from: 'location', key: '' });
    expect(byId.patchJob).toMatchObject({ capture: { path: '/jobs/{jobId}' }, inverse: { body: { from: 'before-request-keys' } } });
  });
});
