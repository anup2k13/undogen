/**
 * One agent session against the demo Todo API, written to a journal. The
 * Python tests run the same session with the Python client and require the
 * two journals to match (python/tests/test_parity.py).
 *
 *   tsx test/fixtures/parity-session.ts <baseUrl> <journal> <full|minimal>
 */
import { FileJournalStore, loadSpec, UndoableClient } from '../../src/index.js';

const [baseUrl, journal, detail] = process.argv.slice(2) as [string, string, 'full' | 'minimal'];
const spec = await loadSpec(new URL('../../examples/todo-api/openapi.yaml', import.meta.url).pathname);
const c = await UndoableClient.open({ spec, baseUrl, store: new FileJournalStore(journal), journalDetail: detail });
const id = (r: { data: unknown }) => (r.data as { id: string }).id;

const t = id(await c.call('createTodo', { body: { title: 'Grüße', tags: ['a'] } }));
await c.call('updateTodo', { params: { todoId: t }, body: { title: 'changed', done: true } });
await c.call('replaceTodo', { params: { todoId: t }, body: { title: 'replaced' } });
await c.call('archiveTodo', { params: { todoId: t } });
const cm = id(await c.call('createComment', { params: { todoId: t }, body: { text: 'hi' } }));
await c.call('deleteComment', { params: { todoId: t, commentId: cm } });
const t2 = id(await c.call('createTodo', { body: { title: 'second' } }));
await c.call('deleteTodo', { params: { todoId: t2 } });
await c.undoAll();
