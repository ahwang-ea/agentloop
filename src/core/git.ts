// core/git.ts — Git CLI adapter implementation.
import { ok } from '../shared/result.js';
import type { AgentloopConfig, GitAdapter } from '../types/index.js';
import { createGitChangeOps } from './git-changes.js';
import { createGitMergeOps } from './git-merge.js';
import { createGitRunner } from './git-runner.js';
import { createGitWorktreeOps } from './git-worktrees.js';

export function createGitAdapter(config: AgentloopConfig): GitAdapter {
  const runner = createGitRunner(config.repoPath);
  const worktrees = createGitWorktreeOps(config, runner);
  const changes = createGitChangeOps(config, runner);
  const merges = createGitMergeOps(config, runner, worktrees, changes);
  return {
    createBranch: worktrees.createBranch,
    async checkoutBranch(name) { const worktree = await worktrees.ensureWorktree(name); return worktree.ok ? ok(undefined) : worktree; },
    checkoutBase: worktrees.ensureBaseWorktree,
    async commit(message, branch) { const cwd = await worktrees.ensureWorktree(branch); return cwd.ok ? changes.commitIn(cwd.value, message) : cwd; },
    async commitBase(message, base) { const cwd = await worktrees.ensureBaseWorktree(base); return cwd.ok ? changes.commitIn(cwd.value, message, true) : cwd; },
    async getDiff(from, to, cwd) { return changes.diffIn(cwd ?? config.repoPath, from, to); },
    merge: merges.merge,
    prepareMerge: merges.prepareMerge,
    abortMerge: merges.abortMerge,
    abandonBranch: merges.abandonBranch,
    rebaseAll: merges.rebaseAll,
    revertFiles: changes.revertFiles,
    trackedFiles: changes.trackedFiles,
    currentBranch: worktrees.current,
  };
}
