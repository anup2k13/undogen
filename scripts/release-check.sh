#!/usr/bin/env bash
# Pack the npm package and the Python package exactly as they would be published,
# install them into clean directories, and use them the way a user would.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "== npm package"
(cd "$root" && npm run build --silent && npm pack --silent --pack-destination "$work" >/dev/null)
tarball="$(ls "$work"/undogen-*.tgz)"
contents="$(tar tzf "$tarball")" # listed once: `tar | grep -q` fails under pipefail when grep exits early
for f in package/dist/cli.js package/dist/index.d.ts package/dist/mcp.js package/README.md package/LICENSE package/CHANGELOG.md; do
  grep -qx "$f" <<< "$contents" || { echo "missing from tarball: $f"; exit 1; }
done
if grep -qE '^package/(src|test|examples|python)/' <<< "$contents"; then echo "tarball contains sources or tests"; exit 1; fi

mkdir "$work/node" && cd "$work/node"
npm init -y >/dev/null && npm pkg set type=module >/dev/null
npm install --no-fund --no-audit --silent "$tarball" typescript@5.6.2 @types/node@22
test "$(npx undogen --version)" = "$(node -p "require('$root/package.json').version")"
npx undogen analyze "$root/examples/todo-api/openapi.yaml" > /dev/null
cat > use.ts <<'TS'
import { analyze, loadSpec, UndoableClient, type JournalEntry } from 'undogen';
import { createMcpServer } from 'undogen/mcp';
const spec = await loadSpec(process.argv[2]!);
const entries: JournalEntry[] = new UndoableClient({ spec, baseUrl: 'http://localhost:1' }).journal;
const { server } = await createMcpServer({ spec, baseUrl: 'http://localhost:1' });
console.log(analyze(spec).summary.total, entries.length, typeof server.connect);
TS
echo '{"compilerOptions":{"module":"nodenext","moduleResolution":"nodenext","target":"es2022","strict":true,"types":["node"],"skipLibCheck":false},"files":["use.ts"]}' > tsconfig.json
npx tsc -p .
test "$(node use.js "$root/examples/todo-api/openapi.yaml")" = "9 0 function"
echo "   ok: CLI, ESM import, undogen/mcp, type declarations"

echo "== Python package"
python3 -m venv "$work/py"
"$work/py/bin/pip" install --quiet build
"$work/py/bin/python" -m build --outdir "$work/pydist" "$root/python" >/dev/null
wheel="$(unzip -l "$work"/pydist/*.whl)"
grep -q 'dist-info/licenses/LICENSE\|dist-info/LICENSE' <<< "$wheel" || { echo "wheel has no LICENSE"; exit 1; }
"$work/py/bin/pip" install --quiet "$work"/pydist/*.whl
(cd "$work" && "$work/py/bin/python" -c "import undogen, undogen.adapters.langchain, undogen.adapters.openai_agents; print('   ok: wheel', undogen.__version__)")
rm -rf "$root/python/build" "$root"/python/*.egg-info
