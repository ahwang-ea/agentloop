import { execFile } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, TaskQueueAdapter, TaskState } from '../types/index.js';
import { featureBranchName } from './feature.js';
import { normalizeBranchPrefix, withBranchPrefix, worktreePathForBranch, worktreeRootPath } from './worktree.js';

const exec = promisify(execFile);
const active = new Set(['writing', 'verifying', 'reviewing', 'fixing', 'cleanup', 'merging', 'finalizing']);
const hour = 60 * 60 * 1000;
const msg = (error: unknown) => [(error as { stderr?: string }).stderr, (error as { stdout?: string }).stdout, error instanceof Error ? error.message : String(error)].filter(Boolean).join('\n');
const exists = async (path: string) => stat(path).then(() => true).catch(() => false);
const ignore = (text: string) => /ENOENT|not a working tree|No such file|not found|unknown revision|cannot remove|not fully merged/i.test(text);
const baseFor = (config: AgentloopConfig, task: TaskState) => task.finalization?.mergeInto ?? (task.task.feature ? withBranchPrefix(config, featureBranchName(task.task.feature)) : config.baseBranch);
const rel = (root: string, path: string) => relative(root, path).replace(/\\/g, '/');
const shotgunBranch = (config: AgentloopConfig, root: string, path: string) => {
  const branch = rel(root, path), prefix = normalizeBranchPrefix(config.branchPrefix), name = branch.slice(prefix.length);
  return branch.startsWith(prefix) && !name.includes('/') && /-shot-[2-9]\d*$/.test(name) ? branch : undefined;
};

async function runGit(config: AgentloopConfig, args: string[]): Promise<Result<void>> {
  try { await exec('git', args, { cwd: config.repoPath }); return ok(undefined); }
  catch (error) { const text = msg(error); return ignore(text) ? ok(undefined) : err('GIT_ERROR', text); }
}

async function baseDirs(root: string, current = root, found: string[] = []): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(current, entry.name);
    if (await exists(join(path, '.git'))) found.push(path);
    else await baseDirs(root, path, found);
  }
  return found;
}

async function pruneParents(root: string, current: string) {
  while (current.startsWith(root) && current !== root) {
    const entries = await readdir(current).catch(() => [] as string[]);
    if (entries.length > 0) return;
    await rm(current, { recursive: true, force: true });
    current = dirname(current);
  }
}

export async function removeBranch(config: AgentloopConfig, branch: string): Promise<Result<void>> {
  try {
    const path = worktreePathForBranch(config, branch);
    const removed = await runGit(config, ['worktree', 'remove', '--force', path]);
    if (!removed.ok) return removed;
    await rm(path, { recursive: true, force: true });
    return runGit(config, ['branch', '-d', withBranchPrefix(config, branch)]);
  } catch (error) { return err('TRANSPORT_ERROR', msg(error)); }
}

export async function removeOrphanedBases(config: AgentloopConfig, queue: TaskQueueAdapter): Promise<Result<void>> {
  try {
    const tasks = await queue.list();
    if (!tasks.ok) return tasks;
    const needed = new Set(tasks.value.filter(task => active.has(task.status)).map(task => baseFor(config, task)));
    const root = join(worktreeRootPath(config), basename(config.repoPath), '_base');
    for (const path of await baseDirs(root)) {
      if (needed.has(rel(root, path))) continue;
      const removed = await runGit(config, ['worktree', 'remove', '--force', path]);
      if (!removed.ok) return removed;
      await rm(path, { recursive: true, force: true });
      await pruneParents(root, dirname(path));
    }
    return ok(undefined);
  } catch (error) { return err('TRANSPORT_ERROR', msg(error)); }
}

export async function removeStaleShotgunWorktrees(config: AgentloopConfig, queue: TaskQueueAdapter, now = Date.now()): Promise<Result<void>> {
  try {
    const tasks = await queue.list();
    if (!tasks.ok) return tasks;
    const activeBranches = new Set<string>();
    for (const task of tasks.value) {
      if (!active.has(task.status)) continue;
      const branch = task.finalization?.branch ?? task.branch;
      if (branch) activeBranches.add(withBranchPrefix(config, branch));
    }
    const root = join(worktreeRootPath(config), basename(config.repoPath));
    for (const path of await baseDirs(root)) {
      const branch = shotgunBranch(config, root, path);
      if (!branch || activeBranches.has(branch)) continue;
      const age = await stat(path).then(info => now - info.mtimeMs).catch(() => 0);
      if (age <= hour) continue;
      const removed = await runGit(config, ['worktree', 'remove', '--force', path]);
      if (!removed.ok) return removed;
      await rm(path, { recursive: true, force: true });
      await pruneParents(root, dirname(path));
    }
    return ok(undefined);
  } catch (error) { return err('TRANSPORT_ERROR', msg(error)); }
}
