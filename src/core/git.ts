// core/git.ts — Git CLI adapter implementation.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { err, ok, type Result } from '../shared/result.js';
import type { BranchState, GitAdapter } from '../types/index.js';

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

export function createGitAdapter(repoPath: string): GitAdapter {
  const run = async (action: string, args: string[]): Promise<Result<string>> => {
    try {
      const { stdout, stderr } = await exec('git', args, { cwd: repoPath });
      return ok(`${stdout}${stderr}`.trim());
    } catch (e) { return map(e, action); }
  };
  const current = async (): Promise<Result<string>> => {
    const r = await run('currentBranch', ['rev-parse', '--abbrev-ref', 'HEAD']);
    return r.ok ? ok(r.value) : r;
  };
  const branches = async (): Promise<Result<string[]>> => {
    const r = await run('listBranches', ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    return r.ok ? ok(r.value.split('\n').map(s => s.trim()).filter(Boolean)) : r;
  };
  return {
    async createBranch(name, from) {
      const base = from ? ok(from) : await current();
      if (!base.ok) return base;
      const createdFrom = base.value;
      const r = await run('createBranch', ['checkout', '-b', name, createdFrom]);
      return r.ok ? ok<BranchState>({ name, createdFrom }) : r;
    },
    async checkoutBranch(name) { const r = await run('checkoutBranch', ['checkout', name]); return r.ok ? ok(undefined) : r; },
    async checkoutBase(base) { const r = await run('checkoutBase', ['checkout', base]); return r.ok ? ok(undefined) : r; },
    async commit(message) {
      const a = await run('add', ['add', '.']); if (!a.ok) return a;
      const c = await run('commit', ['commit', '-m', message]); if (!c.ok) return c;
      return run('revParse', ['rev-parse', 'HEAD']);
    },
    async getDiff(from, to) { return run('getDiff', ['diff', to ? `${from}..${to}` : from]); },
    async merge(branch, into) {
      const co = await run('checkoutMergeTarget', ['checkout', into]); if (!co.ok) return co;
      const mg = await run('merge', ['merge', branch]); if (!mg.ok) return mg;
      return run('mergeHead', ['rev-parse', 'HEAD']);
    },
    async abortMerge() {
      const r = await run('abortMerge', ['merge', '--abort']);
      return !r.ok && /MERGE_HEAD missing|There is no merge to abort/.test(r.error.message) ? ok(undefined) : r.ok ? ok(undefined) : r;
    },
    async abandonBranch(branch) {
      const r = await run('abandonBranch', ['branch', '-D', branch]);
      return !r.ok && r.error.code === 'BRANCH_NOT_FOUND' ? ok(undefined) : r.ok ? ok(undefined) : r;
    },
    async rebaseAll(base, except) {
      const co = await run('checkoutBase', ['checkout', base]); if (!co.ok) return co;
      const list = await branches(); if (!list.ok) return list;
      for (const branch of list.value.filter(name => name !== base && name !== except)) {
        const cb = await run(`checkout(${branch})`, ['checkout', branch]); if (!cb.ok) return cb;
        const rb = await run(`rebase(${branch})`, ['rebase', base]);
        if (!rb.ok) { await run(`abortRebase(${branch})`, ['rebase', '--abort']); return rb; }
      }
      const back = await run('checkoutBase', ['checkout', base]);
      return back.ok ? ok(undefined) : back;
    },
    currentBranch: current,
  };
}
