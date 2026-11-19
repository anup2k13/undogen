# Changelog

## 0.2.0

- **MCP server mode.** `undogen mcp <spec> --base-url <url>` serves any OpenAPI API as MCP tools. Every write is journaled, and the agent gets `undogen_undo`, `undogen_undo_all` and `undogen_journal`. Irreversible operations are hidden unless `--allow-irreversible` is passed, and then they are marked destructive.
- **Safe undo.** Undo refuses to overwrite changes that someone else made after the agent's write, and reports the changed fields (`UndoConflictError`). `force: true` overrides.
- **Persistent journal.** The `journalFile` option appends writes and undos to JSON Lines. `UndoableClient.open()` resumes a journal. `undogen journal` shows it, and `undogen undo` rolls back from another process without the spec.
- **GitHub Action** (`uses: anup2k13/undogen@v0.2.0`) runs `verify` in CI and writes the report to the job summary.
- Compiler: soft deletes via state enums, flat item routes, singleton settings, overrides files, side-effect-free operations, and better id binding (e.g. `issue_number` binds to `response.number`).
- `FORCE_COLOR` support. `requestBody.required` is now read from specs.

## 0.1.0

- First release: `undogen analyze`, `undogen verify`, `UndoableClient`, and the demo API.
