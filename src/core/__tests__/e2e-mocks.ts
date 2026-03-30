import { execFile } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runOrchestrator, type Deps } from '../../orchestrator.js';
import { err, ok, type Result } from '../../shared/result.js';
import type { AgentloopConfig, TaskInput, TaskState } from '../../types/index.js';
import { createFileTaskQueue } from '../task-queue.js';
import { cleanupPrompt } from '../writer-prompt.js';
import { worktreePathForBranch } from '../worktree.js';
const exec = promisify(execFile);
type Mode = 'happy' | 'stuck' | 'debug';
interface Scenario { result: Awaited<ReturnType<typeof runOrchestrator>>; tasks: TaskState[]; metrics: string; events: string[]; }
const text = (e: unknown) => e instanceof Error ? e.message : String(e);
const wrap = async <T>(label: string, work: () => Promise<T>): Promise<Result<T>> => {
  try { return ok(await work()); } catch (e) { return err('TRANSPORT_ERROR', `${label}: ${text(e)}`); }
};
const eventFile = (repoPath: string) => join(repoPath, '.events.log');
const readText = (path: string) => wrap(path, async () => {
  try { return await readFile(path, 'utf-8'); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? '' : Promise.reject(e); }
});
const mark = (repoPath: string, event: string) => wrap('mark', async () => { await appendFile(eventFile(repoPath), `${event}\n`, 'utf-8'); });
const verifyScript = (repoPath: string, mode: Mode) => `#!/usr/bin/env bash
set -e
printf 'verify\\n' >> '${eventFile(repoPath)}'
${mode === 'stuck' ? "echo 'src/greet.ts:1:1: error: greet is broken'; exit 1" : 'test -f src/greet.ts'}
`;
const config = (repoPath: string): AgentloopConfig => ({
  repoPath, baseBranch: 'main', branchPrefix: 'al/', worktreeRoot: join(repoPath, '.worktrees'), verifyCommand: './verify.sh',
  agentsMdPath: join(repoPath, 'AGENTS.md'), architectureMdPath: join(repoPath, 'ARCHITECTURE.md'), claudeModel: 'claude', codexModel: 'codex',
  codexEnabled: true, useCodexWriter: true, convergence: { maxWallClock: 30, maxTokens: 100, stuckThreshold: 2, thrashOverlapRatio: 0.5 },
  taskSource: 'file', taskFilePath: join(repoPath, 'tasks.json'), maxParallelAgents: 1, maxTasksPerSession: 3, maxTokensPerSession: 1000, parallelVerify: true, sweepInterval: 99,
});
const task = (mode: Mode): TaskInput => ({
  title: `${mode} path`, description: 'Add greet implementation', type: mode === 'debug' ? 'debug' : 'implement',
  scope: { editableFiles: ['src/greet.ts'], readOnlyContext: ['ARCHITECTURE.md'], forbiddenFiles: [] }, acceptanceCriteria: ['add greet function'], priority: 'medium',
});
async function initRepo(repoPath: string): Promise<Result<void>> {
  return wrap('init repo', async () => {
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, 'AGENTS.md'), '# AGENTS\n', 'utf-8');
    await writeFile(join(repoPath, 'ARCHITECTURE.md'), '# ARCHITECTURE\n- Under 4000 lines total.\n', 'utf-8');
    await writeFile(join(repoPath, 'package.json'), JSON.stringify({ name: 'e2e-repo' }), 'utf-8');
    await exec('git', ['init', '-b', 'main'], { cwd: repoPath });
    const bin = join(repoPath, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'codex'), '#!/usr/bin/env bash\n[ "$1" = "--version" ] && echo codex 0.0.0\n', 'utf-8');
    await chmod(join(bin, 'codex'), 0o755);
  });
}
async function initWorktree(cfg: AgentloopConfig, repoPath: string, branch: string, mode: Mode): Promise<Result<string>> {
  return wrap('init worktree', async () => {
    const cwd = worktreePathForBranch(cfg, branch);
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'verify.sh'), verifyScript(repoPath, mode), 'utf-8');
    await chmod(join(cwd, 'verify.sh'), 0o755);
    return cwd;
  });
}
export async function runScenario(mode: Mode): Promise<Result<Scenario>> {
  const temp = await wrap('mkdtemp', async () => mkdtemp(join(tmpdir(), 'agentloop-e2e-')));
  if (!temp.ok) return temp;
  const repoPath = temp.value, cfg = config(temp.value), paths = new Map<string, string>(), prevPath = process.env.PATH;
  process.env.PATH = `${join(repoPath, 'bin')}:${prevPath ?? ''}`;
  try {
    const seeded = await initRepo(repoPath); if (!seeded.ok) return seeded;
    const queue = createFileTaskQueue(cfg), added = await queue.add(task(mode)); if (!added.ok) return added;
    const diff = async () => {
      const cwd = [...paths.values()][0];
      if (!cwd) return ok('');
      const greet = await readText(join(cwd, 'src', 'greet.ts')); if (!greet.ok) return greet;
      return ok(greet.value ? `diff --git a/src/greet.ts b/src/greet.ts\n--- /dev/null\n+++ b/src/greet.ts\n@@\n+${greet.value.trim()}\n` : '');
    };
    const deps: Deps = {
      config: cfg,
      queue,
      notifier: { send: async () => ok(undefined) },
      codex: { review: async request => {
        const logged = await mark(repoPath, 'codex-review'); if (!logged.ok) return logged;
        return request.diff.includes('src/greet.ts') && !!request.architectureMd ? ok({ reviewer: request.role, findings: [], duration: 0, rawOutput: 'clean' }) : err('CONFIG_ERROR', 'expected diff + architecture');
      } },
      claude: {
        startSession: async () => ok({ id: 's', taskId: 't' }), waitForStop: async () => ok({ text: 'unused', changedFiles: [], tokenEstimate: 1 }),
        fix: async () => ok({ text: 'unused', changedFiles: [], tokenEstimate: 1 }), cleanup: async () => ok({ text: 'unused', changedFiles: [], tokenEstimate: 1 }),
        review: async request => {
          const logged = await mark(repoPath, 'claude-review'); if (!logged.ok) return logged;
          return request.diff.includes('src/greet.ts') && !!request.architectureMd ? ok({ reviewer: request.role, findings: [], duration: 0, rawOutput: 'clean' }) : err('CONFIG_ERROR', 'expected diff + architecture');
        },
        chat: async () => ok({ text: '[]', tokensDelta: 0, changedFiles: [], stopReason: 'end_turn' }), scaffold: async () => ok({ files: [] }), evictTaskSessions: async () => ok(undefined),
      },
      codexWriter: {
        write: async (_prompt, cwd) => {
          const logged = await mark(repoPath, 'write'); if (!logged.ok) return logged;
          return wrap('write greet', async () => { await writeFile(join(cwd, 'src', 'greet.ts'), 'export const greet = (name: string) => `hi ${name}`;\n', 'utf-8'); return { text: 'wrote greet', changedFiles: ['src/greet.ts'], tokenEstimate: 1 }; });
        },
        fix: async (prompt, cwd) => {
          const logged = await mark(repoPath, prompt === cleanupPrompt ? 'cleanup' : 'fix'); if (!logged.ok) return logged;
          return wrap('fix greet', async () => {
            if (prompt === cleanupPrompt) await writeFile(join(cwd, 'src', 'greet.ts'), 'export const greet = (name: string) => `hi ${name}`;\n', 'utf-8');
            return { text: prompt === cleanupPrompt ? 'cleanup' : 'retry', changedFiles: ['src/greet.ts'], tokenEstimate: 1 };
          });
        },
      },
      git: {
        createBranch: async (name, from) => { const path = await initWorktree(cfg, repoPath, name, mode); if (!path.ok) return path; paths.set(name, path.value); return ok({ name, createdFrom: from ?? 'main', worktreePath: path.value }); },
        checkoutBranch: async () => ok(undefined), checkoutBase: async () => ok(undefined), commit: async () => ok('commit-1'), commitBase: async () => ok('base-1'),
        getDiff: diff, prepareMerge: async () => ok(undefined), abortMerge: async () => ok(undefined), abandonBranch: async () => ok(undefined), rebaseAll: async () => ok(undefined), revertFiles: async () => ok(undefined), currentBranch: async () => ok('main'),
        merge: async () => { const logged = await mark(repoPath, 'merge'); return logged.ok ? ok('merge-1') : logged; },
      },
    };
    const result = await runOrchestrator(deps), listed = await queue.list(); if (!listed.ok) return listed;
    const metrics = await readText(join(repoPath, '.agentloop', 'metrics.jsonl')); if (!metrics.ok) return metrics;
    const events = await readText(eventFile(repoPath)); if (!events.ok) return events;
    return ok({ result, tasks: listed.value, metrics: metrics.value, events: events.value.trim() ? events.value.trim().split('\n') : [] });
  } finally {
    process.env.PATH = prevPath;
    try { await rm(repoPath, { recursive: true, force: true }); } catch (e) { console.error(`e2e cleanup: ${text(e)}`); }
  }
}
