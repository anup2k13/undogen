/**
 * End-to-end demo: start the Todo API, compile undo plans, use the runtime
 * client like an agent would, then verify every inverse against the server.
 *
 *   npm run demo
 */
import { readFile } from 'node:fs/promises';
import { analyze, formatAnalysis, IrreversibleOperationError, loadSpec, UndoableClient, verify } from '../src/index.js';
import { c, formatResultLine, formatSummary } from '../src/report.js';
import { startTodoServer } from './todo-api/server.js';

const here = new URL('./todo-api/', import.meta.url);
const server = await startTodoServer();
try {
  const spec = await loadSpec(new URL('openapi.yaml', here).pathname);

  // 1. Compile.
  const analysis = analyze(spec);
  console.log(formatAnalysis(analysis));

  // 2. Use it like an agent would.
  console.log(c.bold('An agent session through UndoableClient\n'));
  const client = new UndoableClient({ spec, baseUrl: server.url, plans: analysis.plans });
  const todo = await client.call('createTodo', { body: { title: 'Ship undogen' } });
  const id = (todo.data as { id: string }).id;
  await client.call('updateTodo', { params: { todoId: id }, body: { title: 'Ship undogen v0.1', done: true } });
  console.log(`  agent created ${id} and edited it:`, JSON.stringify((await client.call('getTodo', { params: { todoId: id } })).data));
  try {
    await client.call('sendReminder', { params: { todoId: id } });
  } catch (err) {
    if (err instanceof IrreversibleOperationError) console.log(c.magenta(`  ⛔ blocked: ${err.operationId} is irreversible and was not approved`));
  }
  const { undone } = await client.undoAll();
  const after = await client.call('getTodo', { params: { todoId: id } });
  console.log(`  undoAll() reverted ${undone.length} writes; GET ${id} -> HTTP ${after.status}\n`);

  // 3. Prove it.
  console.log(`${c.bold('undogen verify')}  ${c.dim('·')}  proving every compiled inverse against the live server\n`);
  const fixtures = JSON.parse(await readFile(new URL('fixtures.json', here), 'utf8'));
  const ops = spec.operations.filter((o) => o.method !== 'get');
  const idW = Math.max(...ops.map((o) => o.id.length)) + 2;
  const pathW = Math.max(...ops.map((o) => o.path.length)) + 2;
  const report = await verify({
    spec,
    baseUrl: server.url,
    plans: analysis.plans,
    fixtures,
    onResult: (r) => console.log(formatResultLine(r, idW, pathW)),
  });
  console.log(formatSummary(report));
} finally {
  await server.close();
}
