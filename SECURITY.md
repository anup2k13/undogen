# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository. Don't open a public issue for them.

## What undogen protects against, and what it doesn't

undogen sits between an agent and an API. Its job is to make the agent's writes undoable and to make the ones that can't be undone explicit.

**It does:**

- **Gate irreversible and unknown operations.** They are refused unless an approval function (or, in `undogen mcp`, a human via MCP elicitation) allows them.
- **Refuse replays.** An irreversible call identical to one already in the journal is refused again, including across restarts with a persisted journal. That covers an agent restored from a checkpoint repeating a payment or an email.
- **Refuse to overwrite other people's changes.** Before undoing, the state the call produced is re-read; if a field it wrote (or, for actions, a field it changed) differs, the undo stops with a `ConflictError`. `If-Match` is sent when the API provides ETags. `verify --check-conflicts` proves this on your API.
- **Keep credentials out of the agent's hands.** Tools accept only the header parameters an operation declares; `Authorization`, `Cookie`, `Accept` and `Content-Type` are never taken from the spec as parameters, and configured headers always win over per-call ones. A tool call can't replace the configured credentials.
- **Keep calls on the approved route.** Path parameters can't be `.`, `..` or empty, so an agent can't turn a reversible call into a request against a parent route (e.g. `DELETE /projects/p1/members/..` reaching `DELETE /projects/p1/`), past the approval gate and tool filters.
- **Show the human what they approve.** MCP approval prompts show the concrete request: the resolved path, the query, and the body (secret-looking values masked).
- **Keep untrusted specs from reading your machine.** A spec loaded from a URL only follows `$ref`s on its own origin, never to local files or other hosts (such as cloud metadata endpoints), whose contents could otherwise end up in requests `verify` sends. `--trust-refs` lifts this for specs you trust.
- **Keep journals private.** Journal files are created with mode `0600`. With `journalDetail: 'minimal'`, only what undo needs is stored, with conflict-check values as salted hashes.
- **Keep reports shareable.** Values under secret-looking keys are always masked in written reports; `--redact` masks everything. The HTML report has no scripts or external assets.

**It doesn't:**

- **Undo effects outside the API.** Emails a server sent as a side effect, webhooks that already fired, and what people saw in the meantime are beyond any inverse. undogen marks such operations irreversible where it can tell; declare the rest with `x-undogen`.
- **Make compiled plans true.** Plans are hypotheses until `undogen verify` proves them on a sandbox. Don't trust an unverified plan with production data.
- **Protect against a malicious API.** The API's responses decide ids and captured state.
- **Sandbox `verify`.** It creates and deletes real data. Point it at a sandbox, never at production.

## Handling of secrets in this repository's tooling

- Never commit API tokens. Pass them with `--header` from an environment variable or CI secret.
- The GitHub Action masks values in reports by default (`redact: true`).
