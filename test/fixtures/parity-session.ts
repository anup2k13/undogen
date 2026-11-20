/**
 * One agent session against the demo Todo API, written to a journal. The
 * Python tests run the same session with the Python client and require the
 * two journals to match (python/tests/test_parity.py).
 *
 *   tsx test/fixtures/parity-session.ts <baseUrl> <journal> <full|minimal> [children]
 *
 * With `children`, the session deletes a todo that has comments (restoreChildren),
 * so undo re-creates them under new ids and later undos follow the id remap.
 */
import { FileJournalStore, loadSpec, UndoableClient } from '../../src/index.js';

const [baseUrl, journal, detail, mode] = process.argv.slice(2) as [string, string, 'full' | 'minimal', string?];
const spec = await loadSpec(new URL('../../examples/todo-api/openapi.yaml', import.meta.url).pathname);
const restoreChildren = mode === 'children';
const c = await UndoableClient.open({ spec, baseUrl, store: new FileJournalStore(journal), journalDetail: detail, restoreChildren });
const id = (r: { data: unknown }) => (r.data as { id: string }).id;

if (restoreChildren) {
  const t = id(await c.call('createTodo', { body: { title: 'with comments' } }));
  await c.call('createComment', { params: { todoId: t }, body: { text: 'first' } });
  await c.call('createComment', { params: { todoId: t }, body: { text: 'second' } });
  await c.call('deleteTodo', { params: { todoId: t } });
  await c.undoAll();
  process.exit(0);
}

const t = id(await c.call('createTodo', { body: { title: 'Grüße', tags: ['a'] } }));
await c.call('updateTodo', { params: { todoId: t }, body: { title: 'changed', done: true } });
await c.call('replaceTodo', { params: { todoId: t }, body: { title: 'replaced' } });
await c.call('archiveTodo', { params: { todoId: t } });
const cm = id(await c.call('createComment', { params: { todoId: t }, body: { text: 'hi' } }));
await c.call('deleteComment', { params: { todoId: t, commentId: cm } });
const t2 = id(await c.call('createTodo', { body: { title: 'second' } }));
await c.call('deleteTodo', { params: { todoId: t2 } });
await c.undoAll();
