#!/usr/bin/env bash
# Everything that must pass before a commit: typecheck, the TS suite, the Python suite.
# Exit codes are real (no output filtering in a pipe that could hide a failure).
set -euo pipefail
cd "$(dirname "$0")/.."
npx tsc --noEmit
npx vitest run --reporter=dot
python="${PYTHON:-python3}"
(cd python && "$python" -m pytest -q)
echo "check: all passed"
