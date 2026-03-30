#!/usr/bin/env bash
set -u

start_ts="$(date +%s)"
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp_dir=""
worktree_dir=""
log_file=""

elapsed() { echo "$(( $(date +%s) - start_ts ))s"; }
fail() { echo "FAIL ($(elapsed)): $1"; exit 1; }
cleanup() { [ -n "$tmp_dir" ] && [ -d "$tmp_dir" ] && rm -rf "$tmp_dir"; [ -n "$worktree_dir" ] && [ -d "$worktree_dir" ] && rm -rf "$worktree_dir"; }
trap cleanup EXIT

[ -n "${ANTHROPIC_API_KEY:-}" ] || fail 'Missing ANTHROPIC_API_KEY'
[ -n "${OPENAI_API_KEY:-}" ] || fail 'Missing OPENAI_API_KEY'
command -v codex >/dev/null 2>&1 || fail 'Missing codex CLI on PATH'

cd "$root" || fail 'Cannot enter repo root'
npm run build >/dev/null || fail 'agentloop build failed'

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/agentloop-e2e-real.XXXXXX")"
worktree_dir="${tmp_dir}.worktrees"
log_file="$tmp_dir/agentloop-start.log"
cd "$tmp_dir" || fail 'Cannot enter temp repo'

deps="$(ROOT_PATH="$root" node <<'NODE'
const fs = require('node:fs');
const pkg = JSON.parse(fs.readFileSync(`${process.env.ROOT_PATH}/package.json`, 'utf8'));
const exact = name => `${name}@${String(pkg.devDependencies[name]).replace(/^[^0-9]*/, '')}`;
console.log(['typescript', 'jest', 'ts-jest'].map(exact).join(' '));
NODE
)"
npm init -y >/dev/null 2>&1 || fail 'npm init -y failed'
npm install --silent $deps >/dev/null 2>&1 || fail 'npm install failed'
git init -b main >/dev/null 2>&1 || fail 'git init failed'
git config user.email e2e@agentloop.local || fail 'git user.email failed'
git config user.name agentloop-e2e || fail 'git user.name failed'
node "$root/dist/cli.js" init >/dev/null || fail 'agentloop init failed'
WORKTREE_DIR="$worktree_dir" node <<'NODE'
const fs = require('node:fs');
fs.writeFileSync('agentloop.e2e.json', `${JSON.stringify({ repoPath: '.', taskFilePath: 'tasks.json', worktreeRoot: process.env.WORKTREE_DIR, architectureMdPath: null }, null, 2)}\n`);
NODE
mkdir -p src test || fail 'mkdir failed'

cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
JSON
cat > jest.config.cjs <<'JS'
module.exports = { preset: 'ts-jest', testEnvironment: 'node', testMatch: ['**/test/**/*.test.js'], moduleFileExtensions: ['js', 'ts', 'json'] };
JS
cat > test/greet.test.js <<'JS'
const { greet } = require('../src/greet');
test('greet returns a string containing the name', () => {
  const value = greet('Ada');
  expect(typeof value).toBe('string');
  expect(value).toMatch(/Ada/);
});
JS
node <<'NODE'
const fs = require('node:fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.scripts = { ...pkg.scripts, test: 'jest', typecheck: 'tsc --noEmit', build: 'tsc' };
fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
NODE

ROOT_PATH="$root" node --input-type=module <<'NODE'
const root = process.env.ROOT_PATH;
const { loadConfig } = await import(`${root}/dist/core/cli-config.js`);
const { createFileTaskQueue } = await import(`${root}/dist/core/task-queue.js`);
const loaded = await loadConfig('agentloop.e2e.json');
if (!loaded.ok) { console.error(loaded.error.message); process.exit(1); }
const queue = createFileTaskQueue(loaded.value);
const added = await queue.add({
  title: 'Add greet function',
  description: 'Create src/greet.ts exporting greet(name: string): string that returns a greeting.',
  type: 'implement',
  scope: { editableFiles: ['src/greet.ts'], readOnlyContext: ['AGENTS.md', 'ARCHITECTURE.md', 'test/greet.test.js'], forbiddenFiles: [] },
  acceptanceCriteria: ['src/greet.ts exists', 'greet(name: string) returns a greeting'],
  priority: 'medium',
});
if (!added.ok) { console.error(added.error.message); process.exit(1); }
NODE
printf 'export {}\n' > src/agentloop-preflight.ts || fail 'bootstrap preflight file failed'
npm run typecheck >/dev/null 2>&1 || fail 'bootstrap typecheck failed'
rm -f src/agentloop-preflight.ts || fail 'bootstrap preflight cleanup failed'
[ -s tasks.json ] || fail 'tasks.json was not seeded'

git add . >/dev/null 2>&1 || fail 'git add failed'
git commit -m 'chore: bootstrap e2e repo' >/dev/null 2>&1 || fail 'initial commit failed'

python3 - "$root/dist/cli.js" "$tmp_dir" "$log_file" <<'PY'
import os, signal, subprocess, sys
cli, cwd, log = sys.argv[1:4]
with open(log, 'w') as out:
    child = subprocess.Popen(['node', cli, 'start', '--config', 'agentloop.e2e.json'], cwd=cwd, env=os.environ.copy(), stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        raise SystemExit(child.wait(timeout=300))
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGTERM)
        try: child.wait(timeout=10)
        except subprocess.TimeoutExpired: os.killpg(child.pid, signal.SIGKILL)
        raise SystemExit(124)
PY
status="$?"
[ "$status" -eq 0 ] || { tail -n 50 "$log_file" 2>/dev/null || true; [ "$status" -eq 124 ] && fail 'agentloop start timed out after 5 minutes'; fail 'agentloop start failed'; }

node -e "const fs=require('node:fs');try{const tasks=JSON.parse(fs.readFileSync('tasks.json','utf8'));process.exit(tasks.some(t=>t.task&&t.task.id&&t.status==='done')?0:1)}catch{process.exit(2)}" || fail 'task did not reach done in tasks.json'
[ -f src/greet.ts ] || fail 'src/greet.ts was not created'
[ -s .agentloop/metrics.jsonl ] || fail '.agentloop/metrics.jsonl is missing or empty'
npm test -- --runTestsByPath test/greet.test.js >/dev/null 2>&1 || fail 'greet behavior test failed'

echo "PASS ($(elapsed)): real e2e succeeded"
exit 0
