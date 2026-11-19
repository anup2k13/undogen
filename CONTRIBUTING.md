# Contributing

## Setup

```bash
npm install
pip install -e "python[test]"        # optional: the Python client
bash scripts/check.sh               # typecheck, TypeScript tests, Python tests: must exit 0 before a commit
```

Node.js 20+ and Python 3.9+.

## Where things live

| Path | What |
|---|---|
| `src/spec.ts` | Loading OpenAPI 3.x / Swagger 2.0, `$ref` resolution, schema normalization |
| `src/analyze.ts` | The compiler: one rule per API shape, producing an `InversePlan` per write operation |
| `src/runtime.ts` | `UndoableClient`: journaling, conflict checks, undo, id remapping, stores |
| `src/verify.ts` | Proving plans against a sandbox |
| `src/tools.ts`, `src/mcp.ts` | Agent tools and the MCP server |
| `src/lint.ts`, `src/diff.ts`, `src/learn.ts`, `src/init.ts`, `src/export.ts` | The other commands |
| `python/undogen/` | The Python runtime, reading plans compiled by `undogen compile` |
| `examples/todo-api/` | The demo API with two planted reversibility bugs |
| `test/fixtures/` | Other test APIs (a three-level projects API) |

## Changing the analyzer

Analyzer rules are heuristics, so every change is checked against real APIs:

1. Add a test with a small spec that shows the shape (`test/analyze.test.ts`).
2. Run `npx tsx scripts/plan-diff.ts`. It compiles GitHub, Stripe, Twilio, Asana, Slack and Kubernetes with your working tree and with `HEAD`, and lists every plan that changed. **Read every change.** Most false positives in this project were found this way (a token revocation paired with a read-only check, a team deletion matched to adding team access).
3. If the numbers move, regenerate `docs/benchmarks.md` with `npx tsx scripts/benchmark.ts --out docs/benchmarks.md` and update the table in the README.

When in doubt, prefer `unknown` to a wrong inverse: an unknown operation is gated, a wrong inverse silently does the wrong thing.

## Changing the runtime

The TypeScript and Python runtimes share the journal format, so a session started in one can be undone by the other. Change both, and keep the cross-runtime tests in `python/tests/test_client.py` passing.

## Releasing

Bump the version in `package.json` and `python/pyproject.toml`, add the changes to `CHANGELOG.md`, and push a `v<version>` tag. The release workflow runs the tests and `scripts/release-check.sh`, then publishes to npm (with provenance) and PyPI (trusted publishing).
