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
    expect(plain.archiveTodo).toMatchObject({ check: { method: 'get', path: '/todos/{todoId}' }, checkMode: 'diff' });
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

describe('analyze: Stripe, Twilio, Slack and Kubernetes shapes', () => {
  const ok = { '200': { description: '', content: { 'application/json': { schema: { type: 'object', properties: { sid: { type: 'string' }, id: { type: 'string' } } } } } } };
  const spec = parseSpec({
    openapi: '3.0.3',
    info: { title: 'Shapes', version: '1' },
    paths: {
      '/v1/customers': { post: { operationId: 'PostCustomers', responses: ok } },
      '/v1/customers/{customer}': {
        get: { operationId: 'GetCustomer', responses: ok },
        post: { operationId: 'PostCustomersCustomer', responses: ok },
        delete: { operationId: 'DeleteCustomer', responses: ok },
      },
      '/2010-04-01/Accounts/{AccountSid}/Calls.json': { post: { operationId: 'CreateCall2', responses: ok } },
      '/2010-04-01/Accounts/{AccountSid}/Queues.json': { post: { operationId: 'CreateQueue', responses: ok } },
      '/2010-04-01/Accounts/{AccountSid}/Queues/{Sid}.json': {
        get: { operationId: 'FetchQueue', responses: ok },
        post: { operationId: 'UpdateQueue', responses: ok },
        delete: { operationId: 'DeleteQueue', responses: ok },
      },
      '/conversations.archive': { post: { operationId: 'conversations_archive', responses: ok } },
      '/conversations.unarchive': { post: { operationId: 'conversations_unarchive', responses: ok } },
      '/pins.add': { post: { operationId: 'pins_add', responses: ok } },
      '/pins.remove': { post: { operationId: 'pins_remove', responses: ok } },
      '/api/v1/namespaces/{namespace}/configmaps': {
        post: { operationId: 'createConfigMap', responses: ok },
        delete: { operationId: 'deleteCollectionConfigMap', responses: ok },
      },
      '/api/v1/namespaces/{namespace}/configmaps/{name}': {
        get: { operationId: 'readConfigMap', responses: ok },
        delete: { operationId: 'deleteConfigMap', responses: ok },
      },
    },
  });
  const byId = Object.fromEntries(analyze(spec).plans.map((p) => [p.operationId, p]));

  it('treats POST to an item as an update (Stripe style)', () => {
    expect(byId.PostCustomersCustomer).toMatchObject({
      strategy: 'restore-snapshot',
      capture: { path: '/v1/customers/{customer}' },
      inverse: { method: 'post', body: { from: 'before-request-keys' } },
      inverseIfMissing: { method: 'delete' },
    });
  });

  it('understands .json path suffixes (Twilio style)', () => {
    expect(byId.CreateQueue).toMatchObject({
      strategy: 'delete-created',
      inverse: { path: '/2010-04-01/Accounts/{AccountSid}/Queues/{Sid}.json', bindings: { AccountSid: { from: 'params', key: 'AccountSid' }, Sid: { from: 'response', key: 'sid' } } },
    });
    expect(byId.UpdateQueue!.strategy).toBe('restore-snapshot');
    expect(byId.DeleteQueue!.strategy).toBe('recreate-from-snapshot');
  });

  it('pairs RPC-style methods and passes the same arguments (Slack style)', () => {
    expect(byId.conversations_archive).toMatchObject({ strategy: 'paired-action', inverse: { operationId: 'conversations_unarchive', body: { from: 'request' } } });
    expect(byId.pins_remove!.inverse!.operationId).toBe('pins_add');
  });

  it('gates deleting a whole collection (Kubernetes deletecollection)', () => {
    expect(byId.deleteCollectionConfigMap).toMatchObject({ reversibility: 'irreversible' });
    expect(byId.deleteConfigMap!.reversibility).toBe('compensable');
  });
});

describe('analyze: patterns mined from GitHub and Stripe', () => {
  const empty = { '201': { description: '', content: { 'application/json': { schema: { type: 'object', properties: {} } } } } };
  const spec = parseSpec({
    openapi: '3.0.3',
    info: { title: 'Mined', version: '1' },
    paths: {
      '/orgs/{org}/variables': {
        post: {
          operationId: 'createVariable',
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } } } } } },
          responses: empty,
        },
      },
      '/orgs/{org}/variables/{name}': { delete: { operationId: 'deleteVariable', responses: { '204': { description: '' } } } },
      '/orgs/{org}/access/selected_users': {
        post: { operationId: 'addUsers', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { usernames: { type: 'array' } } } } } }, responses: { '204': { description: '' } } },
        delete: { operationId: 'removeUsers', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { usernames: { type: 'array' } } } } } }, responses: { '204': { description: '' } } },
      },
      '/orgs/{org}/attestations/bulk-list': { post: { operationId: 'listAttestationsBulk', responses: { '200': { description: '' } } } },
      '/orgs/{org}/attestations/delete-request': { post: { operationId: 'deleteAttestationsBulk', responses: { '200': { description: '' } } } },
      '/v1/invoices/{invoice}/void': { post: { operationId: 'PostInvoicesInvoiceVoid', responses: { '200': { description: '' } } } },
      '/v1/reviews/{review}/approve': { post: { operationId: 'PostReviewsReviewApprove', responses: { '200': { description: '' } } } },
      '/v1/reviews/{review}/unapprove': { post: { operationId: 'PostReviewsReviewUnapprove', responses: { '200': { description: '' } } } },
    },
  });
  const byId = Object.fromEntries(analyze(spec).plans.map((p) => [p.operationId, p]));

  it('binds a client-chosen identifier from the request', () => {
    expect(byId.createVariable).toMatchObject({
      reversibility: 'reversible',
      strategy: 'delete-created',
      inverse: { operationId: 'deleteVariable', bindings: { org: { from: 'params', key: 'org' }, name: { from: 'request', key: 'name' } } },
    });
  });

  it('pairs POST and DELETE on the same route, passing the same body', () => {
    expect(byId.addUsers).toMatchObject({ strategy: 'toggle', inverse: { operationId: 'removeUsers', body: { from: 'request' } } });
    expect(byId.removeUsers!.inverse!.operationId).toBe('addUsers');
  });

  it('recognises read-only POSTs and one-way transitions', () => {
    expect(byId.listAttestationsBulk!.strategy).toBe('no-side-effects');
    expect(byId.deleteAttestationsBulk).toMatchObject({ reversibility: 'irreversible', reasons: ['"delete" is a one-way transition and the API offers no counterpart'] });
    expect(byId.PostInvoicesInvoiceVoid!.reversibility).toBe('irreversible');
  });

  it('still pairs a one-way-sounding verb when the API has its counterpart', () => {
    expect(byId.PostReviewsReviewApprove).toMatchObject({ strategy: 'paired-action', inverse: { operationId: 'PostReviewsReviewUnapprove' } });
  });
});

describe('analyze: same-route pairs are not read-only and only get bodies they accept', () => {
  const body = { content: { 'application/json': { schema: { type: 'object', properties: { access_token: { type: 'string' } } } } } };
  const spec = parseSpec({
    openapi: '3.0.3',
    info: { title: 'x', version: '1' },
    paths: {
      '/applications/{client_id}/token': {
        post: { operationId: 'apps/check-token', requestBody: body, responses: { '200': { description: '' } } },
        delete: { operationId: 'apps/delete-token', requestBody: body, responses: { '204': { description: '' } } },
      },
      '/repos/{owner}/{repo}/issues/{issue_number}/lock': {
        put: { operationId: 'issues/lock', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { lock_reason: { type: 'string' } } } } } }, responses: { '204': { description: '' } } },
        delete: { operationId: 'issues/unlock', responses: { '204': { description: '' } } },
      },
    },
  });
  const byId = Object.fromEntries(analyze(spec).plans.map((p) => [p.operationId, p]));
  it('does not undo a token revocation with a token check', () => {
    expect(byId['apps/check-token']!.strategy).toBe('no-side-effects');
    expect(byId['apps/delete-token']!.reversibility).toBe('irreversible');
  });
  it('does not send a body to an inverse that takes none', () => {
    expect(byId['issues/lock']).toMatchObject({ strategy: 'toggle', inverse: { operationId: 'issues/unlock' } });
    expect(byId['issues/lock']!.inverse!.body).toBeUndefined();
  });
});

describe('analyze: compound action pairs (Asana style)', () => {
  const body = (props: string[]) => ({ content: { 'application/json': { schema: { type: 'object', properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])) } } } });
  const spec = parseSpec({
    openapi: '3.0.3',
    info: { title: 'Asana-ish', version: '1' },
    paths: {
      '/tasks/{task_gid}/addProject': { post: { operationId: 'addProjectForTask', requestBody: body(['project', 'insert_before', 'section']), responses: {} } },
      '/tasks/{task_gid}/removeProject': { post: { operationId: 'removeProjectForTask', requestBody: body(['project']), responses: {} } },
      '/users/{user_gid}/notifications/markRead': { post: { operationId: 'markRead', responses: {} } },
      '/users/{user_gid}/notifications/markUnread': { post: { operationId: 'markUnread', responses: {} } },
      '/subscriptions/{id}/pause': { post: { operationId: 'pause', requestBody: body(['behavior']), responses: {} } },
      '/subscriptions/{id}/resume': { post: { operationId: 'resume', requestBody: body(['proration_behavior']), responses: {} } },
      '/projects/{project_gid}/sections': { post: { operationId: 'createSectionForProject', responses: { '201': { description: '', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: { gid: { type: 'string' } } } } } } } } } } },
      '/sections/{section_gid}': { delete: { operationId: 'deleteSection', responses: { '200': { description: '' } } } },
    },
  });
  const byId = Object.fromEntries(analyze(spec).plans.map((p) => [p.operationId, p]));

  it('pairs addX with removeX and forwards only the fields the counterpart accepts', () => {
    expect(byId.addProjectForTask).toMatchObject({ strategy: 'paired-action', inverse: { operationId: 'removeProjectForTask', body: { from: 'request', fields: ['project'] } } });
    expect(byId.removeProjectForTask!.inverse!.operationId).toBe('addProjectForTask');
  });

  it('flips a trailing word (markRead <-> markUnread) under a non-item route', () => {
    expect(byId.markRead!.inverse!.operationId).toBe('markUnread');
    expect(byId.markUnread!.inverse!.operationId).toBe('markRead');
  });

  it('does not forward a body between simple pairs that take different arguments', () => {
    expect(byId.pause).toMatchObject({ strategy: 'paired-action', inverse: { operationId: 'resume' } });
    expect(byId.pause!.inverse!.body).toBeUndefined();
  });

  it('follows a sub-collection create to a top-level item route', () => {
    expect(byId.createSectionForProject).toMatchObject({
      strategy: 'delete-created',
      inverse: { operationId: 'deleteSection', bindings: { section_gid: { from: 'response', key: 'data.gid' } } },
    });
  });
});

describe('analyze: compound pairs and top-level routes stay conservative', () => {
  const json = (schema: object) => ({ content: { 'application/json': { schema } } });
  const spec = parseSpec({
    openapi: '3.0.3',
    info: { title: 'x', version: '1' },
    paths: {
      '/invoices/{invoice}/add_lines': {
        post: { operationId: 'addLines', requestBody: json({ type: 'object', required: ['lines'], properties: { lines: { type: 'array', items: { type: 'object', properties: { amount: { type: 'integer' } } } } } }), responses: {} },
      },
      '/invoices/{invoice}/remove_lines': {
        post: { operationId: 'removeLines', requestBody: json({ type: 'object', required: ['lines'], properties: { lines: { type: 'array', items: { type: 'object', required: ['id', 'behavior'], properties: { id: { type: 'string' }, behavior: { type: 'string' } } } } } }), responses: {} },
      },
      '/repos/{owner}/{repo}/restrictions/teams': {
        post: { operationId: 'addTeamRestrictions', requestBody: json({ type: 'object', properties: { teams: { type: 'array' } } }), responses: { '200': { description: '', ...json({ type: 'array', items: { type: 'object' } }) } } },
        delete: { operationId: 'removeTeamRestrictions', requestBody: json({ type: 'object', properties: { teams: { type: 'array' } } }), responses: {} },
      },
      '/teams/{team_id}': { delete: { operationId: 'deleteTeamLegacy', responses: {} } },
    },
  });
  const byId = Object.fromEntries(analyze(spec).plans.map((p) => [p.operationId, p]));

  it('does not pair actions whose counterpart needs fields the request never had', () => {
    expect(byId.addLines!.reversibility).toBe('unknown');
    expect(byId.removeLines!.reversibility).toBe('unknown');
  });

  it('does not let a loose top-level route displace a same-route toggle', () => {
    expect(byId.addTeamRestrictions).toMatchObject({ strategy: 'toggle', inverse: { operationId: 'removeTeamRestrictions' } });
  });
});

describe('analyze: restore actions and plural/singular siblings', () => {
  const body = (props: string[]) => ({ content: { 'application/json': { schema: { type: 'object', required: [props[0]], properties: Object.fromEntries(props.map((p) => [p, { type: 'integer' }])) } } } });
  const spec = parseSpec({
    openapi: '3.0.3',
    info: { title: 'x', version: '1' },
    paths: {
      '/user/packages/{name}/versions/{version_id}': { delete: { operationId: 'deleteVersion', responses: {} } },
      '/user/packages/{name}/versions/{version_id}/restore': { post: { operationId: 'restoreVersion', responses: {} } },
      '/repos/{repo}/issues/{n}/sub_issues': { post: { operationId: 'addSubIssue', requestBody: body(['sub_issue_id', 'replace_parent']), responses: {} } },
      '/repos/{repo}/issues/{n}/sub_issue': { delete: { operationId: 'removeSubIssue', requestBody: body(['sub_issue_id']), responses: {} } },
    },
  });
  const byId = Object.fromEntries(analyze(spec).plans.map((p) => [p.operationId, p]));

  it('undoes a restore by deleting the item again', () => {
    expect(byId.restoreVersion).toMatchObject({ strategy: 'paired-action', inverse: { operationId: 'deleteVersion', path: '/user/packages/{name}/versions/{version_id}' } });
  });

  it('pairs a plural add with its singular remove, passing the shared identifying fields', () => {
    expect(byId.addSubIssue).toMatchObject({ strategy: 'toggle', inverse: { operationId: 'removeSubIssue', body: { from: 'request', fields: ['sub_issue_id'] } } });
    expect(byId.removeSubIssue!.inverse!.operationId).toBe('addSubIssue');
  });
});
