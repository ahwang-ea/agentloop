import { isAbsolute, relative } from 'node:path';
import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig } from '../types/index.js';
import type { GitRunner } from './git-runner.js';

export interface GitChangeOps {
  guardRootBaseMerge(cwd: string, action: string): Promise<Result<void>>;
  diffIn(cwd: string, from: string, to?: string): Promise<Result<string>>;
  commitIn(cwd: string, message: string, tracked?: boolean): Promise<Result<string>>;
  revertFiles(paths: string[], cwd: string): Promise<Result<void>>;
  trackedFiles(paths: string[], cwd: string): Promise<Result<string[]>>;
}

const uniquePaths = (paths: string[]) => [...new Set(paths.filter(Boolean))];

export function createGitChangeOps(config: AgentloopConfig, runner: GitRunner): GitChangeOps {
  const taskFile = ((path: string) => (isAbsolute(path) ? relative(config.repoPath, path) : path).replace(/^\.\//, ''))(config.taskFilePath ?? 'tasks.json');
  const taskArg = taskFile && !taskFile.startsWith('..') ? [`:(exclude)${taskFile}`] : [];
  return {
    async guardRootBaseMerge(cwd, action) {
      if (cwd != config.repoPath) return ok(undefined);
      const dirty = await runner.listFiles(cwd, ['diff', '--name-only', 'HEAD']); if (!dirty.ok) return dirty;
      const files = dirty.value.filter(file => file !== taskFile && !file.startsWith('.agentloop/'));
      return files.length === 0 ? ok(undefined) : err('DIRTY_TREE', `${action}: repo root has tracked changes`, { files });
    },
    async diffIn(cwd, from, to) {
      const tracked = await runner.run(cwd, 'getDiff', ['diff', to ? `${from}..${to}` : from]); if (!tracked.ok) return tracked;
      if (to) return tracked;
      const untracked = await runner.listFiles(cwd, ['ls-files', '--others', '--exclude-standard']); if (!untracked.ok) return untracked;
      const extra: string[] = [];
      for (const file of untracked.value) { const diff = await runner.noIndexDiff(cwd, file); if (!diff.ok) return diff; extra.push(diff.value); }
      return ok([tracked.value, ...extra].filter(Boolean).join('\n\n').trim());
    },
    async commitIn(cwd, message, tracked = false) {
      const add = await runner.run(cwd, 'add', tracked ? (cwd == config.repoPath ? ['add', '-u', '--', '.', ...taskArg, ':(exclude).agentloop/**'] : ['add', '-u']) : ['add', '.']);
      if (!add.ok) return add;
      const commit = await runner.run(cwd, 'commit', ['commit', '-m', message]);
      return !commit.ok && /nothing to commit|no changes added to commit/i.test(commit.error.message)
        ? runner.run(cwd, 'revParse', ['rev-parse', 'HEAD'])
        : commit.ok ? runner.run(cwd, 'revParse', ['rev-parse', 'HEAD']) : commit;
    },
    async revertFiles(paths, cwd) {
      const unique = uniquePaths(paths);
      if (unique.length === 0) return ok(undefined);
      const tracked = await runner.listFiles(cwd, ['ls-files', '--', ...unique]); if (!tracked.ok) return tracked;
      if (tracked.value.length > 0) { const checkedOut = await runner.run(cwd, 'revertTracked', ['checkout', '--', ...tracked.value]); if (!checkedOut.ok) return checkedOut; }
      const untracked = await runner.listFiles(cwd, ['ls-files', '--others', '--exclude-standard', '--', ...unique]); if (!untracked.ok) return untracked;
      if (untracked.value.length > 0) { const cleaned = await runner.run(cwd, 'revertUntracked', ['clean', '-f', '--', ...untracked.value]); if (!cleaned.ok) return cleaned; }
      return ok(undefined);
    },
    async trackedFiles(paths, cwd) {
      const unique = uniquePaths(paths);
      return unique.length === 0 ? ok([]) : runner.listFiles(cwd, ['ls-files', '--', ...unique]);
    },
  };
}
