import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';

interface Todo { id: string; title: string; done: boolean; archived: boolean; createdAt: string; updatedAt: string }
interface Comment { id: string; todoId: string; text: string; createdAt: string }

/**
 * In-memory Todo API used by the demo and the tests.
 * It contains two deliberately planted reversibility bugs (marked BUG below).
 */
export async function startTodoServer(port = 0): Promise<{ url: string; close: () => Promise<void>; sentReminders: string[] }> {
  const todos = new Map<string, Todo>();
  const comments = new Map<string, Comment>();
  const sentReminders: string[] = [];
  let seq = 0;
  const now = () => new Date(Date.now() + seq).toISOString();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';
      const body = await readJson(req);
      const send = (status: number, data?: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, data === undefined ? headers : { 'content-type': 'application/json', ...headers });
        res.end(data === undefined ? undefined : JSON.stringify(data));
      };

      if (parts[0] !== 'todos') return send(404, { error: 'not found' });

      // /todos
      if (parts.length === 1) {
        if (method === 'GET') return send(200, [...todos.values()]);
        if (method === 'POST') {
          if (typeof body?.title !== 'string') return send(400, { error: 'title is required' });
          const t: Todo = { id: `t${++seq}`, title: body.title, done: !!body.done, archived: false, createdAt: now(), updatedAt: now() };
          todos.set(t.id, t);
          return send(201, t);
        }
      }

      const todo = todos.get(parts[1]!);
      if (!todo) return send(404, { error: 'todo not found' });

      // /todos/{id}  (supports conditional writes: ETag on GET, If-Match on PUT/PATCH)
      if (parts.length === 2) {
        if (method === 'GET') return send(200, todo, { etag: etagOf(todo) });
        const ifMatch = req.headers['if-match'];
        if (ifMatch && (method === 'PUT' || method === 'PATCH') && ifMatch !== etagOf(todo)) {
          return send(412, { error: 'precondition failed' });
        }
        if (method === 'PUT') {
          if (typeof body?.title !== 'string') return send(400, { error: 'title is required' });
          Object.assign(todo, { title: body.title, done: !!body.done, updatedAt: now() });
          return send(200, todo);
        }
        if (method === 'PATCH') {
          if ('title' in body) todo.title = String(body.title);
          if ('done' in body) todo.done = !!body.done;
          todo.updatedAt = now();
          return send(200, todo);
        }
        if (method === 'DELETE') {
          todos.delete(todo.id);
          // BUG: cascading delete. Re-creating the todo can never bring these back.
          for (const [id, cm] of comments) if (cm.todoId === todo.id) comments.delete(id);
          return send(204);
        }
      }

      // /todos/{id}/<action>
      if (parts.length === 3 && method === 'POST') {
        if (parts[2] === 'archive') {
          todo.archived = true;
          todo.done = true; // BUG: hidden side effect that unarchive never resets.
          todo.updatedAt = now();
          return send(200, todo);
        }
        if (parts[2] === 'unarchive') {
          todo.archived = false;
          todo.updatedAt = now();
          return send(200, todo);
        }
        if (parts[2] === 'send-reminder') {
          sentReminders.push(todo.id);
          return send(202, { queued: true });
        }
      }

      // /todos/{id}/comments
      if (parts[2] === 'comments' && parts.length === 3) {
        if (method === 'GET') return send(200, [...comments.values()].filter((cm) => cm.todoId === todo.id));
        if (method === 'POST') {
          if (typeof body?.text !== 'string') return send(400, { error: 'text is required' });
          const cm: Comment = { id: `c${++seq}`, todoId: todo.id, text: body.text, createdAt: now() };
          comments.set(cm.id, cm);
          return send(201, cm);
        }
      }

      // /todos/{id}/comments/{cid}
      if (parts[2] === 'comments' && parts.length === 4) {
        const cm = comments.get(parts[3]!);
        if (!cm || cm.todoId !== todo.id) return send(404, { error: 'comment not found' });
        if (method === 'GET') return send(200, cm);
        if (method === 'DELETE') {
          comments.delete(cm.id);
          return send(204);
        }
      }

      return send(405, { error: 'method not allowed' });
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: actual } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${actual}`,
    sentReminders,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function etagOf(todo: Todo): string {
  return `"${createHash('sha1').update(JSON.stringify(todo)).digest('hex').slice(0, 16)}"`;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

// `tsx examples/todo-api/server.ts [port]` runs it standalone.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.argv[2] ?? 4010);
  startTodoServer(port).then(({ url }) => console.log(`Todo API listening on ${url}`));
}

