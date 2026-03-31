import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ok } from '../../shared/result.js';
import { createGitAdapter } from '../git.js';
import { ensureIntentBaseline, runIntentCheck } from '../intent-check.js';
import { scanRepo } from '../scanner.js';

const exec = promisify(execFile);
const run = async (cwd: string, ...args: string[]) => exec('git', args, { cwd });
const repo = async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentloop-git-'));
  await run(root, 'init', '-b', 'main');
  await run(root, 'config', 'user.email', 'test@agentloop.local');
  await run(root, 'config', 'user.name', 'agentloop-test');
  await writeFile(join(root, 'README.md'), '# test\n', 'utf-8');
  await run(root, 'add', '.');
  await run(root, 'commit', '-m', 'init');
  return root;
};
const cfg = (root: string) => ({ repoPath: root, worktreeRoot: `${root}.worktrees`, baseBranch: 'main', branchPrefix: 'al/' } as never);

test('checkoutBase returns the repo path when base is already checked out', async () => {
  const root = await repo();
  const checkedOut = await createGitAdapter(cfg(root)).checkoutBase('main');
  expect(checkedOut.ok).toBe(true);
  if (!checkedOut.ok) return;
  expect(checkedOut.value).toBe(root);
  await expect(access(join(`${root}.worktrees`, '_base', 'main'))).rejects.toBeDefined();
});

test('checkoutBase reuses an existing worktree for a feature branch', async () => {
  const root = await repo();
  const git = createGitAdapter(cfg(root));
  const branch = await git.createBranch('feature-types', 'main');
  expect(branch.ok).toBe(true);
  if (!branch.ok) return;
  const checkedOut = await git.checkoutBase(branch.value.name);
  expect(checkedOut.ok).toBe(true);
  if (!checkedOut.ok) return;
  expect(checkedOut.value.replace('/private', '')).toBe(branch.value.worktreePath.replace('/private', ''));
});

test('runIntentCheck works when the repo root already holds the base branch', async () => {
  const root = await repo(), current = await scanRepo(root);
  expect(current.ok).toBe(true);
  if (!current.ok) return;
  const baseline = await ensureIntentBaseline(root, current.value);
  expect(baseline.ok).toBe(true);
  if (!baseline.ok) return;
  const sent: string[] = [];
  const result = await runIntentCheck(cfg(root), createGitAdapter(cfg(root)), { send: async note => { sent.push(note.summary); return ok(undefined); } }, 'feature-x', 'commit-1');
  expect(result.ok).toBe(true);
  expect(sent).toEqual(['Feature feature-x complete']);
});

test('commitBase stages tracked edits without staging unrelated root files when base is already checked out', async () => {
  const root = await repo();
  const git = createGitAdapter(cfg(root));
  const branch = await git.createBranch('feature-merge', 'main');
  expect(branch.ok).toBe(true);
  if (!branch.ok) return;
  await writeFile(join(branch.value.worktreePath, 'feature.txt'), 'feature\n', 'utf-8');
  const committed = await git.commit('feat: add feature', 'feature-merge');
  expect(committed.ok).toBe(true);
  await writeFile(join(root, 'local.txt'), 'local\n', 'utf-8');
  const prepared = await git.prepareMerge('feature-merge', 'main');
  expect(prepared.ok).toBe(true);
  await writeFile(join(root, 'README.md'), '# refreshed\n', 'utf-8');
  const merged = await git.commitBase('merge: feature', 'main');
  expect(merged.ok).toBe(true);
  await expect(exec('git', ['show', 'HEAD:feature.txt'], { cwd: root })).resolves.toMatchObject({ stdout: 'feature\n' });
  await expect(exec('git', ['show', 'HEAD:README.md'], { cwd: root })).resolves.toMatchObject({ stdout: '# refreshed\n' });
  await expect(exec('git', ['show', 'HEAD:local.txt'], { cwd: root })).rejects.toBeDefined();
  const status = (await exec('git', ['status', '--short'], { cwd: root })).stdout;
  expect(status).toContain('?? local.txt');
  expect(status).not.toContain(' M README.md');
});

test('prepareMerge rejects staged root files when base is already checked out', async () => {
  const root = await repo();
  const git = createGitAdapter(cfg(root));
  const branch = await git.createBranch('feature-guard', 'main');
  expect(branch.ok).toBe(true);
  if (!branch.ok) return;
  await writeFile(join(branch.value.worktreePath, 'feature.txt'), 'feature\n', 'utf-8');
  expect((await git.commit('feat: add feature', 'feature-guard')).ok).toBe(true);
  await writeFile(join(root, 'local.txt'), 'local\n', 'utf-8');
  await run(root, 'add', 'local.txt');
  const prepared = await git.prepareMerge('feature-guard', 'main');
  expect(prepared.ok).toBe(false);
  if (prepared.ok) return;
  expect(prepared.error.code).toBe('DIRTY_TREE');
});

test('prepareMerge allows absolute in-repo task files and agentloop churn', async () => {
  const root = await repo();
  await writeFile(join(root, 'tasks.json'), '[]\n', 'utf-8');
  await run(root, 'add', 'tasks.json');
  await run(root, 'commit', '-m', 'add tasks');
  const git = createGitAdapter(Object.assign({}, cfg(root), { taskFilePath: join(root, 'tasks.json') }) as never);
  const branch = await git.createBranch('feature-abs-task', 'main');
  expect(branch.ok).toBe(true);
  if (!branch.ok) return;
  await writeFile(join(branch.value.worktreePath, 'feature.txt'), 'feature\n', 'utf-8');
  expect((await git.commit('feat: add feature', 'feature-abs-task')).ok).toBe(true);
  await writeFile(join(root, 'tasks.json'), '[{}]\n', 'utf-8');
  await mkdir(join(root, '.agentloop'), { recursive: true });
  await writeFile(join(root, '.agentloop', 'metrics.jsonl'), '{}\n', 'utf-8');
  expect((await git.prepareMerge('feature-abs-task', 'main')).ok).toBe(true);
});

test('prepareMerge rejects unstaged tracked root changes when base is already checked out', async () => {
  const root = await repo();
  const git = createGitAdapter(cfg(root));
  const branch = await git.createBranch('feature-dirty', 'main');
  expect(branch.ok).toBe(true);
  if (!branch.ok) return;
  await writeFile(join(branch.value.worktreePath, 'feature.txt'), 'feature\n', 'utf-8');
  expect((await git.commit('feat: add feature', 'feature-dirty')).ok).toBe(true);
  await writeFile(join(root, 'README.md'), '# dirty\n', 'utf-8');
  const prepared = await git.prepareMerge('feature-dirty', 'main');
  expect(prepared.ok).toBe(false);
  if (prepared.ok) return;
  expect(prepared.error.code).toBe('DIRTY_TREE');
});

test('getDiff uses the task worktree and includes untracked files', async () => {
  const root = await repo();
  const git = createGitAdapter(cfg(root));
  await writeFile(join(root, 'tasks.json'), '[]\n', 'utf-8');
  const branch = await git.createBranch('add-greet', 'main');
  expect(branch.ok).toBe(true);
  if (!branch.ok) return;
  await mkdir(join(branch.value.worktreePath, 'src'), { recursive: true });
  await writeFile(join(branch.value.worktreePath, 'src', 'greet.ts'), 'export const greet = () => "hi";\n', 'utf-8');
  const diff = await git.getDiff('main', undefined, branch.value.worktreePath);
  expect(diff.ok).toBe(true);
  if (!diff.ok) return;
  expect(diff.value).toContain('b/src/greet.ts');
  expect(diff.value).not.toContain('tasks.json');
});
