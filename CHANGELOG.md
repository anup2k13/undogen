# Changelog

## Unreleased

### Safety
- **Conflict detection.** Before undoing, the client re-reads the state a call produced and refuses (`ConflictError`) if someone changed a field the agent wrote; `If-Match` is sent when the API provides ETags. `{ force: true }` overrides.
- **Verify can no longer pass a no-op.** A snapshot between the operation and its undo must show a change; otherwise the result is `inconclusive`. Previously an operation that changed nothing was reported as `verified`.
- **Irreversible verbs anywhere in the name or summary.** `createAndSendInvoice` and "Creates an invoice and emails it" are now gated (they were classified reversible). Negations ("without notifying") are respected; descriptions add caveats.
- **Replay guard.** An identical irreversible call is refused a second time (`ReplayBlockedError`), including across restarts with a persisted journal.
- Bulk `DELETE` on a collection is gated as irreversible.

### Runtime
- Persistent journals (`JournalStore`, `FileJournalStore`, `UndoableClient.open()`), undo by seq, `undogen undo` and `undogen journal`.
- Dependency-aware undo (`DependencyError`, `{ cascade: true }`), id remapping after re-creation, opt-in child re-creation (`restoreChildren`, `--restore-children`).
- `Idempotency-Key` on undo requests; retries for `429` (honouring `Retry-After`), timeouts and `5xx`; per-request timeouts; entry status (`active`, `undone`, `failed`, `conflict`).
- Query parameters, form and multipart bodies, header functions and a `beforeRequest` hook.

### Verify
- Deletes everything it created (`--keep` to inspect), probes created resources directly, `--scoped-only` for shared sandboxes.
- `--junit`, `--sarif`, `--redact` (secret-looking keys are always masked), `--strict`.

### Integrations
- `undogen mcp`: MCP server with undo-aware tool annotations, undo/journal tools and approval through elicitation.
- `toolDefinitions()` for any agent framework.
- Python client (`python/`) with LangChain and OpenAI Agents SDK adapters, sharing the journal format.
- `undogen learn`, `undogen init`, `undogen annotate` (x-undogen + OpenAPI links), `undogen arazzo`, `undogen compile`.
- GitHub Action (`action.yml`) with job summary and SARIF output; release workflow with npm provenance and PyPI trusted publishing.

### Specs
- Swagger 2.0, external `$ref`s (fetched in parallel, with retries), `oneOf`/`anyOf`, OpenAPI 3.1 type arrays and `examples`.
- Recursive schemas no longer cut off unrelated deep schemas: `$ref`s are memoised with cycle detection instead of a nesting-depth limit, and anything undogen can't use is reported in `warnings`.
- New shapes: `POST`-to-item updates (Stripe, Twilio), `.json` path suffixes (Twilio), RPC-style pairs (Slack), case- and separator-insensitive field matching.

### Breaking
- Node.js 20 or newer (Node 18 is end-of-life; the test toolchain no longer supports it).
- `JournalEntry` gained `session`, `status` and request `params`; `VerifyReport.summary` gained `inconclusive`. Running `undogen` with no command exits with code 2 (was 1), like other usage errors.

## 0.1.0

Initial release: compile undo operations from OpenAPI specs, verify them against a sandbox, `UndoableClient`.
