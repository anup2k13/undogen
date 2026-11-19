# Improvement log

Continuous improvement run, 19 Nov → 21 Nov 2026 03:00 IST. Each item is implemented with tests,
committed, and pushed; this file records what was done and what is next.

## Backlog (highest value first)

- [ ] Python client: multipart bodies; check Python 3.9 compatibility
- [ ] JSON Patch (`application/json-patch+json`) PATCH operations
- [ ] Examples: Claude Desktop config, Python agent script, GitHub workflow
- [ ] Analyzer performance: avoid O(n²) lookups in `finishPlan`

## Done

- **Self-review fixes** (19 Nov): an irreversible call (e.g. a reminder about a todo) no longer blocks undoing what it used; a client constructed directly on an existing journal file loads it first instead of reusing sequence numbers (which silently overwrote entries); POST undos are no longer retried after a timeout/5xx (could re-create twice when the API ignores idempotency keys); header parameters are exposed in agent tools (TS + Python).
- **Analyzer rules mined from real APIs** (19 Nov): client-chosen ids bound from the request (GitHub variables), same-route add/remove pairs with the request body (`…/selected_users`), more read-only POST verbs (`bulk-list`, `check-token`), one-way transitions gated when no counterpart exists (`void`, `finalize`, `delete-request`). Spot-checking caught two false positives that were fixed before commit (token revocation paired with the read-only check-token; bodies sent to inverses that take none). GitHub 57% → 62% undo derived, unknown 130 → 89; Stripe unknown 106 → 72.
- **`undogen diff`** (19 Nov): compares two spec versions (operations matched by id, falling back to method + path for renames); reports regressions, improvements, changed inverses, new gated writes and removals; Markdown for PR comments; `--fail-on regressed|gated|any|never`.
- **verify pagination + parallel snapshots** (19 Nov): list routes follow `Link: rel="next"` (same origin and base path only) up to `--max-pages`; snapshot GETs run with `--concurrency`. A test API with a side effect visible only on page 2 is verified with one page and failed with pagination.
- **`undogen_preview` tool** (19 Nov, TS + Python + MCP): reversibility, capture, undo request, `needsApproval` and caveats for any tool, with no API calls. Also fixed a type error in the pagination test that vitest didn't catch (CI typecheck would have).
- **Recursive child restore** (19 Nov, TS + Python): child plans nest up to three levels; capture walks each child's own collections and undo re-creates them under the re-created parents (id remapping links them). New three-level fixture API (`test/fixtures/projects-server.ts`): `verify --restore-children` now verifies both cascading deletes and leaves the API empty.
