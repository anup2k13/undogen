# Improvement log

Continuous improvement run, 19 Nov → 21 Nov 2026 03:00 IST. Each item is implemented with tests,
committed, and pushed; this file records what was done and what is next.

## Backlog (highest value first)

- [ ] verify: parallel snapshot GETs and pagination (Link rel=next) in snapshots
- [ ] MCP / tools: `undogen_preview` tool that shows what undo would do before the agent acts
- [ ] Recursive child capture (grandchildren) for `restoreChildren`
- [ ] Python client: multipart bodies; check Python 3.9 compatibility
- [ ] JSON Patch (`application/json-patch+json`) PATCH operations
- [ ] Examples: Claude Desktop config, Python agent script, GitHub workflow
- [ ] Analyzer performance: avoid O(n²) lookups in `finishPlan`

## Done

- **Self-review fixes** (19 Nov): an irreversible call (e.g. a reminder about a todo) no longer blocks undoing what it used; a client constructed directly on an existing journal file loads it first instead of reusing sequence numbers (which silently overwrote entries); POST undos are no longer retried after a timeout/5xx (could re-create twice when the API ignores idempotency keys); header parameters are exposed in agent tools (TS + Python).
- **Analyzer rules mined from real APIs** (19 Nov): client-chosen ids bound from the request (GitHub variables), same-route add/remove pairs with the request body (`…/selected_users`), more read-only POST verbs (`bulk-list`, `check-token`), one-way transitions gated when no counterpart exists (`void`, `finalize`, `delete-request`). Spot-checking caught two false positives that were fixed before commit (token revocation paired with the read-only check-token; bodies sent to inverses that take none). GitHub 57% → 62% undo derived, unknown 130 → 89; Stripe unknown 106 → 72.
- **`undogen diff`** (19 Nov): compares two spec versions (operations matched by id, falling back to method + path for renames); reports regressions, improvements, changed inverses, new gated writes and removals; Markdown for PR comments; `--fail-on regressed|gated|any|never`.
