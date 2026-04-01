import { constants } from 'node:fs';
import { access, mkdir, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, BranchState } from '../types/index.js';
import { baseWorktreePath, withBranchPrefix, worktreePathForBranch } from './worktree.js';
import type { GitRunner } from './git-runner.js';

interface WorktreeState { path: string; branch?: string; }

export interface GitWorktreeOps {
  branchName(name: string): string;
  worktreePath(name: string): string;
  current(): Promise<Result<string>>;
  listWorktrees(): Promise<Result<WorktreeState[]>>;
  ensureWorktree(name: string): Promise<Result<string>>;
  ensureBaseWorktree(base: string): Promise<Result<string>>;
  createBranch(name: string, from?: string): Promise<Result<BranchState>>;
}

const branchFrom = (line: string) => line.startsWith('branch refs/heads/') ? line.slice('branch refs/heads/'.length) : undefined;
const linkNodeModules = async (repoPath: string, worktreePath: string) => {
  try {
    const source = join(repoPath, 'node_modules');
    await access(source, constants.F_OK);
    await symlink(source, join(worktreePath, 'node_modules'), 'junction');
  } catch { /* no node_modules to link */ }
};

export function createGitWorktreeOps(config: AgentloopConfig, runner: GitRunner): GitWorktreeOps {
  const branchName = (name: string) => withBranchPrefix(config, name);
  const worktreePath = (name: string) => worktreePathForBranch(config, name);
  const mergePath = (base: string) => baseWorktreePath(config, base);
  const current = async (): Promise<Result<string>> => {
    const branch = await runner.runRoot('currentBranch', ['rev-parse', '--abbrev-ref', 'HEAD']);
    return branch.ok ? ok(branch.value) : branch;
  };
  const listWorktrees = async (): Promise<Result<WorktreeState[]>> => {
    const listed = await runner.runRoot('listWorktrees', ['worktree', 'list', '--porcelain']);
    if (!listed.ok) return listed;
    return ok(listed.value.trim().split(/\n\n+/).map(block => {
      const lines = block.split('\n');
      return { path: lines.find(line => line.startsWith('worktree '))?.slice(9) ?? '', branch: lines.map(branchFrom).find(Boolean) };
    }).filter(item => item.path));
  };
  const ensureWorktree = async (name: string): Promise<Result<string>> => {
    const branch = branchName(name), path = worktreePath(branch);
    if (await runner.exists(path)) return ok(path);
    await mkdir(dirname(path), { recursive: true });
    const added = await runner.runRoot('addWorktree', ['worktree', 'add', path, branch]);
    return added.ok ? ok(path) : added;
  };
  const ensureBaseWorktree = async (base: string): Promise<Result<string>> => {
    const branch = await current(); if (!branch.ok) return branch;
    if (branch.value === base) return ok(config.repoPath);
    const worktrees = await listWorktrees(); if (!worktrees.ok) return worktrees;
    const existing = worktrees.value.find(item => item.branch === base);
    if (existing) return ok(existing.path);
    const path = mergePath(base);
    if (await runner.exists(path)) return ok(path);
    await mkdir(dirname(path), { recursive: true });
    const added = await runner.runRoot('addBaseWorktree', ['worktree', 'add', path, base]);
    return added.ok ? ok(path) : added;
  };
  return {
    branchName,
    worktreePath,
    current,
    listWorktrees,
    ensureWorktree,
    ensureBaseWorktree,
    async createBranch(name, from) {
      const base = from ? ok(from) : await current(); if (!base.ok) return base;
      const createdFrom = base.value, branch = branchName(name), path = worktreePath(branch);
      if (await runner.exists(path)) return ok<BranchState>({ name: branch, createdFrom, worktreePath: path });
      await mkdir(dirname(path), { recursive: true });
      const created = await runner.runRoot('createBranch', ['worktree', 'add', '-b', branch, path, createdFrom]);
      if (!created.ok && /already exists/i.test(created.error.message)) return ok<BranchState>({ name: branch, createdFrom, worktreePath: path });
      if (created.ok) await linkNodeModules(config.repoPath, path);
      return created.ok ? ok<BranchState>({ name: branch, createdFrom, worktreePath: path }) : created;
    },
  };
}
