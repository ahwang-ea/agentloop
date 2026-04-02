import { ok, type Result } from '../shared/result.js';
import type { AgentloopConfig } from '../types/index.js';
import { normalizeBranchPrefix } from './worktree.js';
import type { GitChangeOps } from './git-changes.js';
import type { GitRunner } from './git-runner.js';
import type { GitWorktreeOps } from './git-worktrees.js';

export interface GitMergeOps {
  merge(branch: string, into: string): Promise<Result<string>>;
  prepareMerge(branch: string, into: string): Promise<Result<void>>;
  abortMerge(into: string): Promise<Result<void>>;
  abandonBranch(branch: string): Promise<Result<void>>;
  rebaseAll(base: string, except: string): Promise<Result<void>>;
}

export function createGitMergeOps(
  config: AgentloopConfig, runner: GitRunner, worktrees: GitWorktreeOps, changes: GitChangeOps,
): GitMergeOps {
  return {
    async merge(branch, into) {
      const cwd = await worktrees.ensureBaseWorktree(into); if (!cwd.ok) return cwd;
      const safe = await changes.guardRootBaseMerge(cwd.value, 'merge'); if (!safe.ok) return safe;
      const merged = await runner.run(cwd.value, 'merge', ['merge', worktrees.branchName(branch)]);
      return merged.ok ? runner.run(cwd.value, 'mergeHead', ['rev-parse', 'HEAD']) : merged;
    },
    async prepareMerge(branch, into) {
      const cwd = await worktrees.ensureBaseWorktree(into); if (!cwd.ok) return cwd;
      const safe = await changes.guardRootBaseMerge(cwd.value, 'prepareMerge'); if (!safe.ok) return safe;
      const merged = await runner.run(cwd.value, 'prepareMerge', ['merge', '--no-ff', '--no-commit', worktrees.branchName(branch)]);
      return merged.ok ? ok(undefined) : merged;
    },
    async abortMerge(into) {
      const cwd = await worktrees.ensureBaseWorktree(into); if (!cwd.ok) return cwd;
      const aborted = await runner.run(cwd.value, 'abortMerge', ['merge', '--abort']);
      return !aborted.ok && /MERGE_HEAD missing|There is no merge to abort/.test(aborted.error.message) ? ok(undefined) : aborted.ok ? ok(undefined) : aborted;
    },
    async abandonBranch(branch) {
      const path = worktrees.worktreePath(branch), fullBranch = worktrees.branchName(branch);
      if (await runner.exists(path)) {
        const removed = await runner.runRoot('removeWorktree', ['worktree', 'remove', '--force', path]);
        if (!removed.ok && !/not a working tree|No such file or directory/.test(removed.error.message)) return removed;
      }
      const deleted = await runner.runRoot('abandonBranch', ['branch', '-D', fullBranch]);
      return !deleted.ok && deleted.error.code === 'BRANCH_NOT_FOUND' ? ok(undefined) : deleted.ok ? ok(undefined) : deleted;
    },
    async rebaseAll(base, except) {
      const prefix = normalizeBranchPrefix(config.branchPrefix), other = worktrees.branchName(except);
      const list = await worktrees.listWorktrees(); if (!list.ok) return list;
      for (const item of list.value.filter(worktree => worktree.branch && worktree.branch !== other && worktree.branch.startsWith(prefix))) {
        const reverted = await runner.run(item.path, `cleanupTracked(${item.branch})`, ['checkout', '--', '.']);
        if (!reverted.ok) console.error(reverted.error.message);
        const cleaned = await runner.run(item.path, `cleanupUntracked(${item.branch})`, ['clean', '-fd']);
        if (!cleaned.ok) console.error(cleaned.error.message);
        const rebased = await runner.run(item.path, `rebase(${item.branch})`, ['rebase', base]);
        if (!rebased.ok) { await runner.run(item.path, `abortRebase(${item.branch})`, ['rebase', '--abort']); return rebased; }
      }
      return ok(undefined);
    },
  };
}
