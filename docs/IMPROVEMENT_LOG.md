# Improvement log

Continuous improvement run, 19 Nov → 21 Nov 2026 03:00 IST. Each item is implemented with tests,
committed, and pushed; this file records what was done and what is next.

## Backlog (highest value first)

- [ ] Analyzer: mine `unknown` reasons on GitHub / Stripe / Asana for safe new patterns and missing irreversible verbs; re-benchmark
- [ ] `undogen diff`: compare reversibility between two versions of a spec (CI gate for API changes that make writes irreversible)
- [ ] verify: parallel snapshot GETs and pagination (Link rel=next) in snapshots
- [ ] MCP / tools: `undogen_preview` tool that shows what undo would do before the agent acts
- [ ] Recursive child capture (grandchildren) for `restoreChildren`
- [ ] Python client: multipart bodies; check Python 3.9 compatibility
- [ ] JSON Patch (`application/json-patch+json`) PATCH operations
- [ ] Examples: Claude Desktop config, Python agent script, GitHub workflow
- [ ] Analyzer performance: avoid O(n²) lookups in `finishPlan`

## Done

- **Self-review fixes** (19 Nov): an irreversible call (e.g. a reminder about a todo) no longer blocks undoing what it used; a client constructed directly on an existing journal file loads it first instead of reusing sequence numbers (which silently overwrote entries); POST undos are no longer retried after a timeout/5xx (could re-create twice when the API ignores idempotency keys); header parameters are exposed in agent tools (TS + Python).
