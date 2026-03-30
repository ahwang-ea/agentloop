// core/git.ts — Git CLI adapter implementation.

import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, BranchState, GitAdapter } from '../types/index.js';
import { baseWorktreePath, normalizeBranchPrefix, withBranchPrefix, worktreePathForBranch } from './worktree.js';

const exec = promisify(execFile);
const text = (e: unknown) => {
  const x = e as { stdout?: string; stderr?: string; message?: string };
  return [x.stderr, x.stdout, x.message].filter(Boolean).join('\n').trim() || 'unknown git error';
};
const map = (e: unknown, action: string): Result<never> => {
  const message = text(e);
  const code = /CONFLICT|conflict/.test(message) ? 'MERGE_CONFLICT'
    : /pathspec|did not match any file/.test(message) ? 'BRANCH_NOT_FOUND'
    : /local changes|Please commit your changes/.test(message) ? 'DIRTY_TREE'
    : 'GIT_ERROR';
  return err(code, `${action}: ${message}`);
};
const exists = (path: string) => access(path, constants.F_OK).then(() => true).catch(() => false);
const branchFrom = (line: string) => line.startsWith('branch refs/heads/') ? line.slice('branch refs/heads/'.length) : undefined;

export function createGitAdapter(config: AgentloopConfig): GitAdapter {
  const run = async (cwd: string, action: string, args: string[]): Promise<Result<string>> => {
    try {
      const { stdout, stderr } = await exec('git', args, { cwd });
      return ok(`${stdout}${stderr}`.trim());
    } catch (e) { return map(e, action); }
  };
  const runRoot = (action: string, args: string[]) => run(config.repoPath, action, args);
  const branchName = (name: string) => withBranchPrefix(config, name);
  const worktreePath = (name: string) => worktreePathForBranch(config, name);
  const mergePath = (base: string) => baseWorktreePath(config, base);
  const current = async (): Promise<Result<string>> => {
    const r = await runRoot('currentBranch', ['rev-parse', '--abbrev-ref', 'HEAD']);
    return r.ok ? ok(r.value) : r;
  };
  const listWorktrees = async (): Promise<Result<Array<{ path: string; branch?: string }>>> => {
    const r = await runRoot('listWorktrees', ['worktree', 'list', '--porcelain']);
    if (!r.ok) return r;
    return ok(r.value.trim().split(/\n\n+/).map(block => {
      const lines = block.split('\n');
      return { path: lines.find(line => line.startsWith('worktree '))?.slice(9) ?? '', branch: lines.map(branchFrom).find(Boolean) };
    }).filter(item => item.path));
  };
  const ensureWorktree = async (name: string): Promise<Result<string>> => {
    const branch = branchName(name), path = worktreePath(branch);
    if (await exists(path)) return ok(path);
    await mkdir(dirname(path), { recursive: true });
    const added = await runRoot('addWorktree', ['worktree', 'add', path, branch]);
    return added.ok ? ok(path) : added;
  };
  const ensureBaseWorktree = async (base: string): Promise<Result<string>> => {
    const path = mergePath(base);
    if (await exists(path)) return ok(path);
    await mkdir(dirname(path), { recursive: true });
    const added = await runRoot('addBaseWorktree', ['worktree', 'add', path, base]);
    return added.ok ? ok(path) : added;
  };
  const commitIn = async (cwd: string, message: string) => {
    const add = await run(cwd, 'add', ['add', '.']); if (!add.ok) return add;
    const commit = await run(cwd, 'commit', ['commit', '-m', message]);
    return !commit.ok && /nothing to commit|no changes added to commit/i.test(commit.error.message)
      ? run(cwd, 'revParse', ['rev-parse', 'HEAD'])
      : commit.ok ? run(cwd, 'revParse', ['rev-parse', 'HEAD']) : commit;
  };
  return {
    async createBranch(name, from) {
      const base = from ? ok(from) : await current();
      if (!base.ok) return base;
      const createdFrom = base.value, branch = branchName(name), path = worktreePath(branch);
      if (await exists(path)) return ok<BranchState>({ name: branch, createdFrom, worktreePath: path });
      await mkdir(dirname(path), { recursive: true });
      const r = await runRoot('createBranch', ['worktree', 'add', '-b', branch, path, createdFrom]);
      if (!r.ok && /already exists/i.test(r.error.message)) return ok<BranchState>({ name: branch, createdFrom, worktreePath: path });
      return r.ok ? ok<BranchState>({ name: branch, createdFrom, worktreePath: path }) : r;
    },
    async checkoutBranch(name) { const r = await ensureWorktree(name); return r.ok ? ok(undefined) : r; },
    async checkoutBase(base) { const r = await ensureBaseWorktree(base); return r.ok ? ok(undefined) : r; },
    async commit(message, branch) { const cwd = await ensureWorktree(branch); return cwd.ok ? commitIn(cwd.value, message) : cwd; },
    async commitBase(message, base) { const cwd = await ensureBaseWorktree(base); return cwd.ok ? commitIn(cwd.value, message) : cwd; },
    async getDiff(from, to) { return runRoot('getDiff', ['diff', to ? `${from}..${to}` : from]); },
    async merge(branch, into) {
      const cwd = await ensureBaseWorktree(into); if (!cwd.ok) return cwd;
      const mg = await run(cwd.value, 'merge', ['merge', branchName(branch)]); if (!mg.ok) return mg;
      return run(cwd.value, 'mergeHead', ['rev-parse', 'HEAD']);
    },
    async prepareMerge(branch, into) {
      const cwd = await ensureBaseWorktree(into); if (!cwd.ok) return cwd;
      const mg = await run(cwd.value, 'prepareMerge', ['merge', '--no-ff', '--no-commit', branchName(branch)]);
      return mg.ok ? ok(undefined) : mg;
    },
    async abortMerge(into) {
      const cwd = await ensureBaseWorktree(into); if (!cwd.ok) return cwd;
      const r = await run(cwd.value, 'abortMerge', ['merge', '--abort']);
      return !r.ok && /MERGE_HEAD missing|There is no merge to abort/.test(r.error.message) ? ok(undefined) : r.ok ? ok(undefined) : r;
    },
    async abandonBranch(branch) {
      const path = worktreePath(branch), fullBranch = branchName(branch);
      if (await exists(path)) {
        const rm = await runRoot('removeWorktree', ['worktree', 'remove', '--force', path]);
        if (!rm.ok && !/not a working tree|No such file or directory/.test(rm.error.message)) return rm;
      }
      const r = await runRoot('abandonBranch', ['branch', '-D', fullBranch]);
      return !r.ok && r.error.code === 'BRANCH_NOT_FOUND' ? ok(undefined) : r.ok ? ok(undefined) : r;
    },
    async rebaseAll(base, except) {
      const prefix = normalizeBranchPrefix(config.branchPrefix), other = branchName(except);
      const list = await listWorktrees(); if (!list.ok) return list;
      for (const item of list.value.filter(w => w.branch && w.branch !== other && w.branch.startsWith(prefix))) {
        const rb = await run(item.path, `rebase(${item.branch})`, ['rebase', base]);
        if (!rb.ok) { await run(item.path, `abortRebase(${item.branch})`, ['rebase', '--abort']); return rb; }
      }
      return ok(undefined);
    },
    currentBranch: current,
  };
}
