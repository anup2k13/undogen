# undogen

**Compile undo operations from any OpenAPI spec, then prove they actually work.**

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
- **never executes** operations classified as irreversible.

The exit code is `1` when any inverse fails, so it works as a CI gate. `--report` writes `report.json`, `report.md`, and a [shields.io endpoint badge](https://shields.io/badges/endpoint-badge) (`badge.json`).

> ⚠️ `verify` creates and deletes data. Point it at a sandbox, never at production.

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

## Real-world check: the GitHub REST API

On GitHub's official OpenAPI description (1,281 operations), `undogen analyze` runs in about 3.5 seconds:

| | Write operations |
|---|---|
| Reversible | 302 |
| Compensable | 46 |
| Irreversible (gated) | 131 |
| Unknown (declare via overrides) | 135 |
| **Total** | **614** |

That means **57% of GitHub's write API gets an undo with zero hand-written code**, and the rest is either correctly gated or explicitly flagged. Some examples:

- `issues/create` gets a soft delete: `PATCH …/issues/{response.number}` with `{"state":"closed"}`.
- `issues/create-comment` follows GitHub's flat route to `DELETE …/issues/comments/{response.id}`.
- `actions/set-github-actions-permissions-organization` takes a snapshot first and restores it afterwards.
- `issues/lock` is undone by `DELETE …/lock` (a toggle).
- `actions/cancel-workflow-run` and `repos/create-dispatch-event` are classified irreversible.

The compiled plans are hypotheses. `verify` is what turns them into facts.

## Limits

- Inverses are **compensations**, not distributed transactions. Webhooks that already fired, emails a server sent as a side effect, and things people saw in the meantime are outside any API's reach. undogen's job is to make that boundary explicit.
- Verification can only see state that the API exposes through `GET` routes.
- OpenAPI 3.x with local `$ref`s. Swagger 2.0 and external refs aren't supported yet.

## Roadmap

- MCP proxy mode: put verified undo in front of any MCP server built from an OpenAPI spec
- Learning bindings from verification runs (turning `unknown` into `verified` automatically)
- Persistent journals and multi-process rollback
- Concurrency checks: detect when an undo would overwrite someone else's change made after the agent's
- Swagger 2.0, external `$ref`s, GraphQL mutations

## License

Apache-2.0
