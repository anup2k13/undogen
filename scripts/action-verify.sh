#!/usr/bin/env bash
# Runs `undogen verify` for the GitHub Action (action.yml). Inputs arrive as INPUT_* variables.
# Writes outputs to $GITHUB_OUTPUT and the Markdown report to $GITHUB_STEP_SUMMARY when they are set.
set -uo pipefail

cli="${UNDOGEN_CLI:-dist/cli.js}"
dir="${INPUT_REPORT_DIR:-undogen-report}"
args=(verify "$INPUT_SPEC" --base-url "$INPUT_BASE_URL" --report "$dir" --junit "$dir/junit.xml" --sarif "$dir/undogen.sarif")

[ -n "${INPUT_FIXTURES:-}" ] && args+=(--fixtures "$INPUT_FIXTURES")
[ -n "${INPUT_OVERRIDES:-}" ] && args+=(--overrides "$INPUT_OVERRIDES")
[ -n "${INPUT_ONLY:-}" ] && args+=(--only "$INPUT_ONLY")
[ -n "${INPUT_IGNORE:-}" ] && args+=(--ignore "$INPUT_IGNORE")
[ "${INPUT_STRICT:-false}" = "true" ] && args+=(--strict)
[ "${INPUT_RESTORE_CHILDREN:-false}" = "true" ] && args+=(--restore-children)
[ "${INPUT_SCOPED_ONLY:-false}" = "true" ] && args+=(--scoped-only)
[ "${INPUT_CHECK_CONFLICTS:-false}" = "true" ] && args+=(--check-conflicts)
[ "${INPUT_REDACT:-true}" = "true" ] && args+=(--redact)

while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"
  [ -n "$line" ] && args+=(--header "$line")
done <<< "${INPUT_HEADERS:-}"

if [ -n "${INPUT_ARGS:-}" ]; then
  read -r -a extra <<< "$INPUT_ARGS"
  args+=("${extra[@]}")
fi

node "$cli" "${args[@]}"
code=$?

if [ -f "$dir/report.json" ]; then
  read -r verified failed < <(node -e 'const r=require(require("path").resolve(process.argv[1]));console.log(r.summary.verified, r.summary.failed)' "$dir/report.json")
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      echo "verified=$verified"
      echo "failed=$failed"
      echo "report-dir=$dir"
      echo "sarif-file=$dir/undogen.sarif"
    } >> "$GITHUB_OUTPUT"
  fi
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "$dir/report.md" >> "$GITHUB_STEP_SUMMARY"
fi
exit $code
