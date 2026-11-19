/**
 * A three-level API for tests: projects -> tasks -> notes. Deleting a project
 * cascades to its tasks and their notes. `tsx test/fixtures/projects-server.ts <port>`
 * runs it standalone (the Python tests do).
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';

export const projectsSpec = {
  openapi: '3.0.3',
  info: { title: 'Projects', version: '1' },
  paths: Object.fromEntries(
    (
      [
        ['/projects', 'Project', 'projectId', []],
        ['/projects/{projectId}/tasks', 'Task', 'taskId', ['projectId']],
        ['/projects/{projectId}/tasks/{taskId}/notes', 'Note', 'noteId', ['projectId', 'taskId']],
      ] as const
    ).flatMap(([collection, name, param]) => {
      const schema = { type: 'object', properties: { id: { type: 'string', readOnly: true }, title: { type: 'string' } } };
      const json = { content: { 'application/json': { schema } } };
      const list = { content: { 'application/json': { schema: { type: 'array', items: schema } } } };
      return [
        [collection, { get: { operationId: `list${name}s`, responses: { '200': { description: '', ...list } } }, post: { operationId: `create${name}`, requestBody: json, responses: { '201': { description: '', ...json } } } }],
        [`${collection}/{${param}}`, { get: { operationId: `get${name}`, responses: { '200': { description: '', ...json } } }, delete: { operationId: `delete${name}`, responses: { '204': { description: '' } } } }],
      ];
    }),
  ),
};

interface Row { id: string; title: string; parent?: string }

export async function startProjectsServer(port = 0) {
  const tables: Record<string, Map<string, Row>> = { projects: new Map(), tasks: new Map(), notes: new Map() };
  let seq = 0;
  const remove = (table: string, id: string) => {
    tables[table]!.delete(id);
    const child = table === 'projects' ? 'tasks' : table === 'tasks' ? 'notes' : undefined;
    if (child) for (const r of [...tables[child]!.values()]) if (r.parent === id) remove(child, r.id); // cascade
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const parts = (req.url ?? '').split('?')[0]!.split('/').filter(Boolean);
    const send = (status: number, data?: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(data === undefined ? undefined : JSON.stringify(data));
    const strip = (r: Row) => ({ id: r.id, title: r.title });
    // Walk /projects/{id}/tasks/{id}/notes/{id}, checking each parent exists.
    let parent: string | undefined;
    for (let i = 0; i < parts.length; i += 2) {
      const table = tables[parts[i]!];
      if (!table) return send(404, {});
      const id = parts[i + 1];
      if (id === undefined) {
        if (req.method === 'GET') return send(200, [...table.values()].filter((r) => r.parent === parent).map(strip));
        if (req.method === 'POST') {
          const row = { id: `${parts[i]![0]}${++seq}`, title: String(body.title ?? ''), parent };
          table.set(row.id, row);
          return send(201, strip(row));
        }
        return send(405, {});
      }
      const row = table.get(id);
      if (!row || row.parent !== parent) return send(404, {});
      if (i + 2 >= parts.length) {
        if (req.method === 'GET') return send(200, strip(row));
        if (req.method === 'DELETE') {
          remove(parts[i]!, id);
          return send(204);
        }
        return send(405, {});
      }
      parent = id;
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    tables,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  startProjectsServer(Number(process.argv[2] ?? 4020)).then(({ url }) => console.log(`Projects API listening on ${url}`));
}
