# Improvement log

Continuous improvement run, 19 Nov → 21 Nov 2026 03:00 IST. Each item is implemented with tests,
committed, and pushed; this file records what was done and what is next.

## Backlog (highest value first)

- [ ] Analyzer: compound action pairs (Asana addTag/removeTag, addFollowers/removeFollowers); look at Asana and Slack unknowns
- [ ] Docs: tighten Limits (conflict checks cover what undo writes; paired actions/toggles are unchecked)
- [ ] verify: self-contained HTML report
## Done

- **Self-review fixes** (19 Nov): an irreversible call (e.g. a reminder about a todo) no longer blocks undoing what it used; a client constructed directly on an existing journal file loads it first instead of reusing sequence numbers (which silently overwrote entries); POST undos are no longer retried after a timeout/5xx (could re-create twice when the API ignores idempotency keys); header parameters are exposed in agent tools (TS + Python).
- **Analyzer rules mined from real APIs** (19 Nov): client-chosen ids bound from the request (GitHub variables), same-route add/remove pairs with the request body (`…/selected_users`), more read-only POST verbs (`bulk-list`, `check-token`), one-way transitions gated when no counterpart exists (`void`, `finalize`, `delete-request`). Spot-checking caught two false positives that were fixed before commit (token revocation paired with the read-only check-token; bodies sent to inverses that take none). GitHub 57% → 62% undo derived, unknown 130 → 89; Stripe unknown 106 → 72.
- **`undogen diff`** (19 Nov): compares two spec versions (operations matched by id, falling back to method + path for renames); reports regressions, improvements, changed inverses, new gated writes and removals; Markdown for PR comments; `--fail-on regressed|gated|any|never`.
- **verify pagination + parallel snapshots** (19 Nov): list routes follow `Link: rel="next"` (same origin and base path only) up to `--max-pages`; snapshot GETs run with `--concurrency`. A test API with a side effect visible only on page 2 is verified with one page and failed with pagination.
- **`undogen_preview` tool** (19 Nov, TS + Python + MCP): reversibility, capture, undo request, `needsApproval` and caveats for any tool, with no API calls. Also fixed a type error in the pagination test that vitest didn't catch (CI typecheck would have).
- **Recursive child restore** (19 Nov, TS + Python): child plans nest up to three levels; capture walks each child's own collections and undo re-creates them under the re-created parents (id remapping links them). New three-level fixture API (`test/fixtures/projects-server.ts`): `verify --restore-children` now verifies both cascading deletes and leaves the API empty.
- **Python: multipart bodies + 3.9 check** (19 Nov): multipart/form-data encoding (scalars, JSON for objects, `(filename, bytes, type)` files); the suite passes on Python 3.9.25 (installed with uv) as well as 3.13.
- **JSON Patch + Merge Patch** (19 Nov, TS + Python): `application/json-patch+json` PATCHes get an inverse patch computed from the captured state (`add` restores each touched member, `remove` drops members the patch created; whole-document patches restore the document); conflict checks compare the touched members. `application/merge-patch+json` undo sends `null` for keys the patch added.
- **Speed** (19 Nov): JSON specs are parsed with `JSON.parse` instead of the YAML parser (GitHub 4.1s → 0.3s), schema normalization is memoized per shared schema (Stripe 1.1s → 0.2s), and the analyzer indexes operations by id and item route (GitHub analyze 290ms → 46ms). Checked against the previous commit: 0 differences across 1,870 plans from six real APIs.
- **Examples + PATCH caveat** (19 Nov): `examples/mcp`, `examples/python/agent_session.py` (run by the Python tests), `examples/github-workflow/undogen.yml` (checked against action.yml inputs); plans for plain-JSON PATCH restores now warn that fields the call adds are not removed.
- **Security** (19 Nov, TS + Python): agent tools pass only the operation's declared header parameters (a tool call could previously replace the configured `Authorization` header or set any header); journal files are created with mode 0600 since they hold request and response bodies.
- **Release check** (19 Nov): `scripts/release-check.sh` packs both packages as they'd be published, installs them in clean directories and uses them (CLI, ESM import, `undogen/mcp`, type declarations from a strict TS consumer, the wheel and its adapters). Runs in CI and before publishing. Found and fixed: source maps pointed at unshipped sources (now inlined), CHANGELOG not shipped, wheel without LICENSE, deprecated `license` table in pyproject.
