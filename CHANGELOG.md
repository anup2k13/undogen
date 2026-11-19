# Changelog

## Unreleased

- **`undogen wrap -- <mcp server command>`** adds journaling and undo to any existing stdio MCP server, with no spec needed. Inverses are inferred from tool names and input schemas: create/delete, update with get, delete re-created via create, and soft-delete via a state enum. A config file declares the rest. `--plan` shows what is inferred, and `--hide-irreversible` drops tools that can't be undone. Undo results, conflict detection and the journal file work as in `undogen mcp`.
- `examples/notes-mcp`: a small ordinary MCP server for trying `wrap`.
- **`undogen init`** generates a fixtures file: example bodies for create operations, and `prepare` steps for actions that need their counterpart first. With `--base-url` it probes a sandbox, adds missing setup steps, and lists what still needs a human.
- **New `inconclusive` verify outcome** for operations that changed nothing visible, so their undo was never exercised. These were previously reported as failures, which wrongly blamed the API. The detail suggests the prepare step to add.
- **Swagger 2.0 support**: `in: body` and `formData` parameters, `#/definitions` refs, response schemas, and `basePath`.
- **Base paths**: Swagger `basePath`, or the path of OpenAPI 3 `servers[0].url`, is applied automatically, without being doubled when the base URL already includes it. Journals store full paths, so undo from a journal still works without the spec.
- **Form-encoded bodies** (`application/x-www-form-urlencoded`) in calls, inverses and verification.
- Restore and re-create bodies drop server-managed fields (`resourceVersion`, `uid`, `creationTimestamp`, …).
- Bulk collection deletes and Kubernetes `exec`/`proxy`/`eviction`/`binding`/`token` subresources are gated as irreversible. Kubernetes access reviews are recognised as side-effect-free.

## 0.2.0

- **MCP server mode.** `undogen mcp <spec> --base-url <url>` serves any OpenAPI API as MCP tools. Every write is journaled, and the agent gets `undogen_undo`, `undogen_undo_all` and `undogen_journal`. Irreversible operations are hidden unless `--allow-irreversible` is passed, and then they are marked destructive.
- **Safe undo.** Undo refuses to overwrite changes that someone else made after the agent's write, and reports the changed fields (`UndoConflictError`). `force: true` overrides.
- **Persistent journal.** The `journalFile` option appends writes and undos to JSON Lines. `UndoableClient.open()` resumes a journal. `undogen journal` shows it, and `undogen undo` rolls back from another process without the spec.
- **GitHub Action** (`uses: anup2k13/undogen@v0.2.0`) runs `verify` in CI and writes the report to the job summary.
- Compiler: soft deletes via state enums, flat item routes, singleton settings, overrides files, side-effect-free operations, and better id binding (e.g. `issue_number` binds to `response.number`).
- `FORCE_COLOR` support. `requestBody.required` is now read from specs.

## 0.1.0

- First release: `undogen analyze`, `undogen verify`, `UndoableClient`, and the demo API.
