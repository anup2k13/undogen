# Examples

| Path | What it shows |
|---|---|
| [`todo-api/`](todo-api) | The demo API with two planted reversibility bugs, its spec and fixtures (used by `npm run demo` and the tests) |
| [`demo.ts`](demo.ts) | Compile, use `UndoableClient` like an agent, then verify, in one script |
| [`github/overrides.json`](github/overrides.json) | Overrides for operations of the GitHub REST API that undogen can't infer |
| [`mcp/claude_desktop_config.json`](mcp/claude_desktop_config.json) | Serving an API through `undogen mcp` to Claude Desktop (or any stdio MCP client) |
| [`python/agent_session.py`](python/agent_session.py) | A Python agent session: writes, a refused irreversible call, rollback |
| [`github-workflow/undogen.yml`](github-workflow/undogen.yml) | CI: `diff` on every spec change, `verify` against a sandbox with SARIF annotations |
