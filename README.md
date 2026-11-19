# undogen

[![CI](https://github.com/anup2k13/undogen/actions/workflows/ci.yml/badge.svg)](https://github.com/anup2k13/undogen/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Compile undo operations from any OpenAPI or Swagger spec, then prove they actually work.**

![undogen verify catching a cascading delete and a hidden side effect in a demo API](docs/demo.gif)

AI agents now call real APIs: they open issues, change settings, and delete records. Most "undo for agents" tools ask you to write an inverse for each tool by hand, and nobody checks that those inverses work. An undo button that silently does the wrong thing is worse than having none.

undogen does two things:

1. **Compile.** It reads an OpenAPI spec and derives the undo for every write operation. A `POST` that creates something is undone by the matching `DELETE`. A `PATCH` snapshots the old values and writes them back. Paired actions like `archive`/`unarchive` undo each other, and endpoints that can't be called back (sending email, moving money) are flagged as irreversible.
2. **Verify.** It runs each operation, then its compiled inverse, against a test server. It diffs the state before and after. An inverse is marked *verified* only when the state is equivalent again.

```
$ undogen verify openapi.yaml --base-url http://localhost:4010

  ✓ createTodo     POST   /todos                                reversible   state restored exactly
  ✓ replaceTodo    PUT    /todos/{todoId}                       reversible   state restored exactly
  ✓ updateTodo     PATCH  /todos/{todoId}                       reversible   state restored exactly
  ✗ deleteTodo     DELETE /todos/{todoId}                       compensable  2 difference(s) remain after undo
      GET /todos/{todoId}/comments
        $[0]          {"text":"Looks good to me"}  →  (missing)
      GET /todos/{todoId}/comments/{commentId}
        status        200  →  404
  ✗ archiveTodo    POST   /todos/{todoId}/archive               reversible   2 difference(s) remain after undo
      GET /todos/{todoId}
        $.done        false  →  true
  ✓ unarchiveTodo  POST   /todos/{todoId}/unarchive             reversible   state restored exactly
  ⛔ sendReminder   POST   /todos/{todoId}/send-reminder         irreversible never executed; blocked at runtime unless approved
  ✓ createComment  POST   /todos/{todoId}/comments              reversible   state restored exactly
  ✓ deleteComment  DELETE /todos/{todoId}/comments/{commentId}  compensable  state restored (resource re-created under a new id)

  6 verified · 2 failed · 1 gated · 0 errors · 0 skipped
```

Both failures are real bugs, and nothing in the spec reveals them:

- **Cascading delete.** Deleting a todo also deletes its comments. Re-creating the todo can never bring them back.
- **Hidden side effect.** `archive` also sets `done: true`, and `unarchive` doesn't reset it.

Reading the spec, the compiler believes both inverses are correct. Only running them shows they aren't. That's why undogen has a verifier.

## Try it

```bash
git clone https://github.com/anup2k13/undogen && cd undogen
npm install
npm run demo        # starts a demo API, compiles, runs an agent session, verifies
```

## Use it

### 1. See what's undoable in an API

```bash
npx undogen analyze openapi.yaml
```

```
  createTodo     POST   /todos             reversible   delete-created          0.90
      ↺ undo     DELETE /todos/{todoId}  todoId ← response.id
  updateTodo     PATCH  /todos/{todoId}    reversible   restore-snapshot        0.90
      ◉ capture  GET /todos/{todoId}
      ↺ undo     PATCH /todos/{todoId}  body ← before[keys sent]
  deleteTodo     DELETE /todos/{todoId}    compensable  recreate-from-snapshot  0.65
      ◉ capture  GET /todos/{todoId}
      ↺ undo     POST /todos  body ← before.{title,done}
      ⚠ The re-created resource gets a new identifier
  sendReminder   POST   /todos/{todoId}/send-reminder   irreversible
```

No network calls are made. Add `--json` for machine-readable plans.

### 2. Prove the inverses against a sandbox

Start by generating a fixtures file:

```bash
npx undogen init openapi.yaml --base-url https://sandbox.example.com
```

`init` writes `undogen.fixtures.json` with example bodies for every create operation, and setup steps for actions that only make sense after their counterpart (archive before unarchive). With `--base-url` it also runs the verifier against the sandbox and repairs what it finds: an operation that turns out to change nothing gets a setup step, and anything that still needs a human is listed. Then run:

```bash
npx undogen verify openapi.yaml --base-url https://sandbox.example.com \
  --header "authorization: Bearer $TOKEN" \
  --report ./undogen-report
```

For each write operation, `verify`:

- **creates real resources** for every path parameter, parents first;
- **seeds child resources** (one comment per todo, and so on), so cascading deletes have something to destroy;
- **generates request bodies that actually change state**, so a no-op can't pass as verified;
- **snapshots every readable route**, runs the operation and its inverse, snapshots again, and diffs;
- **follows identity changes** for compensable inverses: when a deleted record is re-created under a new id, it compares by content;
- **flags operations that changed nothing** as *inconclusive* rather than passing them, because an undo that was never exercised proves nothing;
- **never executes** operations classified as irreversible.

The exit code is `1` when any inverse fails, so it works as a CI gate. `--report` writes `report.json`, `report.md`, and a [shields.io endpoint badge](https://shields.io/badges/endpoint-badge) (`badge.json`).

> ⚠️ `verify` creates and deletes data. Point it at a sandbox, never at production.

#### In CI with GitHub Actions

```yaml
- uses: anup2k13/undogen@v0.2.0
  with:
    spec: openapi.yaml
    base-url: http://localhost:4010          # your sandbox / docker-compose service
    fixtures: undogen.fixtures.json          # optional
    headers: |
      authorization: Bearer ${{ secrets.SANDBOX_TOKEN }}
```

The action writes the report into the job summary and exposes `verified` and `failed` outputs. It fails the job when an inverse stops working, so a refactor that breaks undo gets caught before your agents rely on it.

### 3. Give agents an undo button

```ts
import { loadSpec, UndoableClient, IrreversibleOperationError } from 'undogen';

const spec = await loadSpec('openapi.yaml');
const client = new UndoableClient({
  spec,
  baseUrl: 'https://api.example.com',
  headers: { authorization: `Bearer ${process.env.TOKEN}` },
  // Irreversible calls are blocked unless this approves them (human-in-the-loop, policy engine...)
  allowIrreversible: async (op, plan) => askHuman(`Allow ${op.id}? ${plan.reasons[0]}`),
});

await client.call('createTodo', { body: { title: 'Ship it' } });
await client.call('updateTodo', { params: { todoId: 't1' }, body: { done: true } });

client.journal;          // every write, its captured "before" state, and the resolved inverse request
await client.undo();     // undo the most recent write
await client.undoAll();  // saga-style rollback of the whole session, newest first
```

Each journal entry stores the *concrete* inverse request, resolved at call time. The journal is plain JSON: you can persist it, audit it, or replay the rollback later from another process.

#### Persistent journal: roll back later, from anywhere

Pass `journalFile` and every write and undo is appended to a JSON Lines file. Another process can pick it up later, without the spec, and roll back:

```ts
const client = new UndoableClient({ spec, baseUrl, journalFile: 'agent-run.jsonl' });
// ...agent works...
```

```bash
npx undogen journal agent-run.jsonl                          # what happened, and how to undo each write
npx undogen undo --journal agent-run.jsonl --base-url $API   # undo the latest write
npx undogen undo --journal agent-run.jsonl --base-url $API --all   # roll back the whole run
```

The journal contains request and response bodies. Treat it like a log with sensitive data.

#### Safe undo: never clobber someone else's change

Undo is only safe if nobody touched the resource after the agent. Say an agent renames a ticket and a teammate then marks it done: a naive undo writes back the old snapshot and silently erases the teammate's change.

undogen remembers how each resource looked right after the agent's write. Before undoing, it reads the resource again. If anything changed (timestamps and etags excepted), it refuses and tells you exactly what:

```ts
await client.undo();
// UndoConflictError: Refusing to undo #2 (updateTodo): /todos/t1 changed after the write
//   ($.done: false -> true). Pass { force: true } to overwrite those changes.

err.diffs;                                // [{ path: '$.done', before: false, after: true, ... }]
await client.undo(entry, { force: true }); // when you really mean it
```

A created resource that someone already deleted counts as undone, and nothing gets sent.

### 4. Give any MCP agent an undo button

`undogen mcp` serves an OpenAPI-described API as [MCP](https://modelcontextprotocol.io) tools. Every write goes through the journal, and the agent gets three extra tools:

| Tool | What it does |
|---|---|
| `undogen_undo` | Revert the latest write (or one by `seq`). Refuses on conflict and reports what changed. |
| `undogen_undo_all` | Roll back the whole session, newest first. |
| `undogen_journal` | List what the agent changed and how each change can be undone. |

```json
{
  "mcpServers": {
    "todo-api": {
      "command": "npx",
      "args": ["-y", "undogen", "mcp", "./openapi.yaml",
               "--base-url", "https://api.example.com",
               "--header", "authorization: Bearer ${API_TOKEN}",
               "--journal", "./agent-run.jsonl"]
    }
  }
}
```

This works with any MCP client (Cursor, VS Code, Codex, and others):

- **Tool descriptions say what can be undone**, so the model knows before it acts ("Reversible: Undo restores the previous values", "Compensable: re-created under a new id"…).
- **Irreversible operations are hidden** unless you pass `--allow-irreversible`. When exposed, they carry MCP's `destructiveHint`, so clients ask the user first.
- **Conflicts come back as tool errors**, with the exact fields someone else changed, so the agent can ask before forcing.
- **The journal outlives the session**: `undogen undo --journal agent-run.jsonl --all` rolls back from your terminal.

### 5. Add undo to any existing MCP server

No OpenAPI spec? `undogen wrap` sits in front of any stdio MCP server and adds journaling and undo from the outside. It infers inverses from tool names and input schemas:

```bash
npx undogen wrap --plan -- npx -y your-mcp-server     # see what undogen infers, then exit
```

```
  list_notes    read-only    none
  create_note   reversible   delete-created          ↺ delete_note
  update_note   reversible   restore-snapshot        ↺ update_note
  delete_note   compensable  recreate-from-snapshot  ↺ create_note
  send_note     irreversible none                    "send" describes an effect that cannot be called back
  pin_note      unknown      none                    No inverse tool could be inferred; declare one in the config
  create_issue  compensable  soft-delete             ↺ update_issue
```

To use it, point your MCP client at the wrapper instead of the server:

```json
{
  "mcpServers": {
    "notes": {
      "command": "npx",
      "args": ["-y", "undogen", "wrap", "--journal", "./agent-run.jsonl", "--", "npx", "-y", "your-mcp-server"]
    }
  }
}
```

It works much like the OpenAPI mode:

- **Inverses are found by name.** Pairs like `create_x`/`delete_x` and `update_x`/`get_x` are matched, and `create_x` with an `update_x` whose `state` enum includes `closed` becomes a soft delete.
- **Identity values are looked up in results.** For example, `issue_number` is found in `{ "number": 7 }`, and ids are found inside nested objects like `{ "note": { "id": … } }`.
- **Every write result tells the agent how it will be undone**, e.g. `[undogen] journaled as #1; undogen_undo will run delete_note {"id":"n1"}`.
- **Conflict detection** refuses to undo when the data changed after the agent's write.
- **Irreversible and unknown tools are passed through**, but marked `⚠ CANNOT BE UNDONE` with `destructiveHint`. Pass `--hide-irreversible` to drop them entirely.
- **A config file declares what names can't reveal:**

```json
{ "tools": { "pin_note": { "inverse": "update_note", "args": { "id": "request.id", "pinned": { "literal": false } } },
             "publish_post": { "reversibility": "irreversible", "reason": "Readers may already have seen it" } } }
```

Try it with the bundled example server: `npx undogen wrap --plan -- npx tsx examples/notes-mcp/server.ts`.

## How the compiler works

| Pattern in the spec | Strategy | Inverse |
|---|---|---|
| `POST /things` with a `DELETE /things/{id}` | `delete-created` | `DELETE /things/{response.id}` |
| `POST /things` with no `DELETE`, but `PATCH` has `state: [open, closed]` | `soft-delete` | `PATCH /things/{id}` with `{ "state": "closed" }` |
| `POST /a/{x}/things` whose items live at a flat route `/a/things/{id}` | `delete-created` | `DELETE` at the flat route |
| `PATCH /things/{id}` | `restore-snapshot` | `GET` before, then `PATCH` back exactly the keys that were sent |
| `PUT /things/{id}` or `PUT /settings` | `restore-snapshot` | `GET` before, then `PUT` the old writable fields (or `DELETE` if the `PUT` created it) |
| `DELETE /things/{id}` | `recreate-from-snapshot` | `GET` before, then `POST /things` with the old writable fields (*compensable*: the id changes) |
| `POST /things/{id}/archive` and `/unarchive` | `paired-action` | the counterpart (25+ verb pairs, plus `x` / `unx`) |
| `PUT` and `DELETE` on `/things/{id}/star` | `toggle` | the opposite method |
| Verbs like send, notify, charge, transfer, cancel, merge, dispatch… | — | **irreversible**, blocked at runtime |
| Verbs like render, preview, search, validate… | `no-side-effects` | nothing needed (verify proves state is unchanged) |

Every plan comes with a confidence score, its reasons, and caveats. When undogen can't tell, it says `unknown` rather than guessing.

### Declaring what can't be inferred

In your own spec, use `x-undogen`:

```yaml
/todos/{todoId}/explode:
  post:
    operationId: explodeTodo
    x-undogen: { reversibility: irreversible, reason: "It explodes" }
```

For specs you don't control, use an overrides file (`--overrides overrides.json`):

```json
{
  "repos/create-for-authenticated-user": {
    "inverse": "repos/delete",
    "bindings": { "owner": "response.owner.login", "repo": "response.name" }
  },
  "pulls/merge": { "reversibility": "irreversible", "reason": "Merges can only be reverted, never un-merged" }
}
```

Bindings take values from `params.*`, `response.*`, `before.*`, or `request.*`. Bodies can be `"before"`, `"request"`, or `{ "literal": … }`.

## Real-world check: GitHub and Kubernetes

`undogen analyze` on two of the largest public API descriptions, with no hand-written code beyond three GitHub overrides:

| Write operations | GitHub REST (OpenAPI 3) | Kubernetes (Swagger 2.0) |
|---|---:|---:|
| Reversible | 299 | 388 |
| Compensable | 46 | 92 |
| Irreversible (gated) | 146 | 102 |
| Unknown (declare via overrides) | 123 | 4 |
| **Total** | **614** | **586** |
| **Automatic undo** | **56%** | **82%** |
| Analysis time | ~3.5 s | ~1.4 s |

Some examples:

- **GitHub**
  - `issues/create` gets a soft delete: `PATCH …/issues/{response.number}` with `{"state":"closed"}`.
  - `issues/create-comment` follows GitHub's flat route to `DELETE …/issues/comments/{response.id}`.
  - `actions/set-github-actions-permissions-organization` takes a snapshot first and restores it afterwards.
  - `issues/lock` is undone by `DELETE …/lock` (a toggle).
  - `actions/cancel-workflow-run` and `repos/create-dispatch-event` are classified irreversible.
- **Kubernetes**
  - `createCoreV1NamespacedPod` is undone by `DELETE …/pods/{response.metadata.name}`. The compiler finds the name inside `metadata` on its own.
  - `patchAppsV1NamespacedDeployment` takes a snapshot and restores exactly the fields that were patched.
  - Bulk `deleteCollection…`, `exec`, `eviction` and `binding` are gated as irreversible.
  - Read-only access reviews are recognised as side-effect-free.

Restore and re-create bodies drop server-managed fields (`resourceVersion`, `uid`, `creationTimestamp`, …). Sending those back would make the server reject the undo as stale.

When the compiler isn't sure, it stays cautious: an operation it can't classify is gated, never assumed safe. Even so, the compiled plans are hypotheses. `verify` is what turns them into facts.

## Limits

- Inverses are **compensations**, not distributed transactions. Webhooks that already fired, emails a server sent as a side effect, and things people saw in the meantime are outside any API's reach. undogen's job is to make that boundary explicit.
- Verification can only see state that the API exposes through `GET` routes.
- OpenAPI 3.x and Swagger 2.0 with local `$ref`s. External refs aren't supported yet.

## Roadmap

- Undo for wrapped MCP servers from the terminal (`undogen undo` currently replays HTTP journals only)
- Learning bindings from verification runs (turning `unknown` into `verified` automatically)
- External `$ref`s, GraphQL mutations

## Development

```bash
npm test                                          # unit + end-to-end tests against the demo API
npm run demo                                      # full walkthrough in the terminal
npm run build && python3 scripts/render_demo_gif.py   # regenerate docs/demo.gif from real CLI output (needs Pillow)
```

## License

Apache-2.0
