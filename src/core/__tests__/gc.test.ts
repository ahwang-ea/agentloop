import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { jest } from '@jest/globals';
import { archiveOldTasks, gc } from '../gc.js';
import { removeStaleShotgunWorktrees } from '../gc-worktrees.js';
import { pruneNotificationKeys } from '../notifier.js';

const exec = promisify(execFile);
const repo = () => mkdtemp(join(tmpdir(), 'agentloop-gc-'));
const run = (cwd: string, ...args: string[]) => exec('git', args, { cwd });
const config = (repoPath: string) => ({
  repoPath,
  baseBranch: 'main',
  branchPrefix: 'al/',
  worktreeRoot: '~/.agentloop/worktrees',
  verifyCommand: './verify.sh',
  agentsMdPath: 'AGENTS.md',
  architectureMdPath: 'ARCHITECTURE.md',
  claudeModel: 'c', codexModel: 'o', codexEnabled: true,
  convergence: { maxWallClock: 1, maxTokens: 1, stuckThreshold: 1, thrashOverlapRatio: 0.5 },
  taskSource: 'file' as const, taskFilePath: 'tasks.json', maxParallelAgents: 2, maxTasksPerSession: 3, maxTokensPerSession: 100000, parallelVerify: true, sweepInterval: 1,
});
const worktreeConfig = (repoPath: string) => ({ ...config(repoPath), worktreeRoot: `${repoPath}.worktrees` });
const task = { id: 't', title: 'Task', description: '', scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], type: 'implement' as const, priority: 'medium' as const, createdAt: '' };
const gitRepo = async () => {
  const repoPath = await repo();
  await run(repoPath, 'init', '-b', 'main'); await run(repoPath, 'config', 'user.email', 'test@agentloop.local'); await run(repoPath, 'config', 'user.name', 'agentloop-test');
  await writeFile(join(repoPath, 'README.md'), '# test\n'); await run(repoPath, 'add', '.'); await run(repoPath, 'commit', '-m', 'init');
  return repoPath;
};
const fakeWorktree = async (repoPath: string, branch: string, when: number) => {
  const path = join(`${repoPath}.worktrees`, basename(repoPath), branch);
  await mkdir(join(path, '.git'), { recursive: true }); await utimes(path, when / 1000, when / 1000);
  return path;
};
const present = (path: string) => stat(path).then(() => true).catch(() => false);

test('keeps legacy notification keys untouched during pruning', async () => {
  const repoPath = await repo(), path = join(repoPath, '.agentloop', 'notifications.json');
  await mkdir(join(repoPath, '.agentloop'), { recursive: true });
  await writeFile(path, JSON.stringify(['alpha', 'beta'], null, 2));
  const result = await pruneNotificationKeys(config(repoPath));
  expect(result.ok).toBe(true);
  expect(JSON.parse(await readFile(path, 'utf-8'))).toEqual(['alpha', 'beta']);
});

test('prunes dated notification keys older than seven days', async () => {
  const repoPath = await repo(), path = join(repoPath, '.agentloop', 'notifications.json');
  await mkdir(join(repoPath, '.agentloop'), { recursive: true });
  await writeFile(path, JSON.stringify([{ key: 'fresh', createdAt: new Date().toISOString() }, { key: 'stale', createdAt: '2026-03-01T00:00:00.000Z' }], null, 2));
  const result = await pruneNotificationKeys(config(repoPath), Date.parse('2026-03-30T00:00:00.000Z'));
  expect(result.ok).toBe(true);
  expect(JSON.parse(await readFile(path, 'utf-8'))).toEqual([{ key: 'fresh', createdAt: expect.any(String) }]);
});

test('archives old done and stuck tasks', async () => {
  const repoPath = await repo(), tasks = join(repoPath, 'tasks.json');
  await writeFile(tasks, JSON.stringify([
    { task: { ...task, id: 'a' }, status: 'done', round: 0, startedAt: '', completedAt: '2025-01-01T00:00:00.000Z' },
    { task: { ...task, id: 'b' }, status: 'stuck', round: 0, startedAt: '', completedAt: '2025-01-01T00:00:00.000Z' },
    { task: { ...task, id: 'c' }, status: 'blocked', round: 0, startedAt: '', completedAt: '2025-01-01T00:00:00.000Z' },
  ], null, 2));
  const result = await archiveOldTasks(config(repoPath), Date.parse('2026-03-30T00:00:00.000Z'));
  expect(result.ok).toBe(true);
  const raw = JSON.parse(await readFile(tasks, 'utf-8')) as Array<{ task: { id: string } }>;
  expect(Array.isArray(raw)).toBe(true);
  expect(raw.map(item => item.task.id)).toEqual(['c']);
  expect((await readFile(join(repoPath, '.agentloop', 'archive.jsonl'), 'utf-8')).trim().split('\n')).toHaveLength(2);
});

test('archives old done and stuck tasks from wrapped queues', async () => {
  const repoPath = await repo(), tasks = join(repoPath, 'tasks.json');
  await writeFile(tasks, JSON.stringify({
    version: 1,
    tasks: [
      { task: { ...task, id: 'a' }, status: 'done', round: 0, startedAt: '', completedAt: '2025-01-01T00:00:00.000Z', claim: { token: 'tok-a', expiresAt: '2026-04-01T00:00:00.000Z' } },
      { task: { ...task, id: 'b' }, status: 'stuck', round: 0, startedAt: '', completedAt: '2025-01-01T00:00:00.000Z', dedupeKey: 'sweep:b' },
      { task: { ...task, id: 'c' }, status: 'blocked', round: 0, startedAt: '', completedAt: '2025-01-01T00:00:00.000Z' },
      { task: { ...task, id: 'd' }, status: 'done', round: 0, startedAt: '', completedAt: '2026-03-25T00:00:00.000Z' },
    ],
  }, null, 2));
  const result = await archiveOldTasks(config(repoPath), Date.parse('2026-03-30T00:00:00.000Z'));
  expect(result.ok).toBe(true);
  const raw = JSON.parse(await readFile(tasks, 'utf-8')) as { version: number; tasks: Array<{ task: { id: string } }> };
  expect(raw.version).toBe(1);
  expect(raw.tasks.map(item => item.task.id)).toEqual(['c', 'd']);
  const archived = (await readFile(join(repoPath, '.agentloop', 'archive.jsonl'), 'utf-8')).trim().split('\n').map(line => JSON.parse(line) as { task: { task: { id: string } } });
  expect(archived.map(item => item.task.task.id)).toEqual(['a', 'b']);
});

test('rotates stale metrics logs during gc', async () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  const repoPath = await repo(), metrics = join(repoPath, '.agentloop', 'metrics.jsonl');
  const archivedAt = new Date(Date.now() - (100 * 24 * 60 * 60 * 1000));
  const archivedName = `metrics-${archivedAt.toISOString().slice(0, 10)}.jsonl`;
  await mkdir(join(repoPath, '.agentloop'), { recursive: true });
  await writeFile(metrics, '{"task":"old"}\n');
  await utimes(metrics, archivedAt, archivedAt);
  const result = await gc({
    config: config(repoPath),
    queue: { list: async () => ({ ok: true, value: [] }) } as never,
    claude: { evictTaskSessions: async () => ({ ok: true, value: undefined }) } as never,
  }, task, { mergeCommit: 'abc', branch: 'al/task', mergeInto: 'main', behaviorNotified: true, readmeTaskEnsured: true, completionNotified: true, rebaseDone: true, failCount: 0 });
  expect(result.ok).toBe(true);
  expect(await readFile(metrics, 'utf-8')).toBe('');
  expect(await stat(join(repoPath, '.agentloop', 'metrics-archive', archivedName)).then(() => true)).toBe(true);
  error.mockRestore();
});

test('removes only stale inactive true shotgun worktrees', async () => {
  const now = Date.parse('2026-04-01T12:00:00.000Z'), repoPath = await gitRepo(), cfg = worktreeConfig(repoPath);
  const staleShot = await fakeWorktree(repoPath, 'al/task-shot-2', now - (2 * 60 * 60 * 1000));
  const falseHit = await fakeWorktree(repoPath, 'al/fix-shot-bug-abc12345', now - (2 * 60 * 60 * 1000));
  const result = await removeStaleShotgunWorktrees(cfg, { list: async () => ({ ok: true, value: [] }) } as never, now);
  expect(result.ok).toBe(true); expect(await present(staleShot)).toBe(false); expect(await present(falseHit)).toBe(true);
});

test('keeps active stale shotgun worktrees from queue state', async () => {
  const now = Date.parse('2026-04-01T12:00:00.000Z'), repoPath = await gitRepo(), cfg = worktreeConfig(repoPath), staleShot = await fakeWorktree(repoPath, 'al/task-shot-2', now - (2 * 60 * 60 * 1000));
  const result = await removeStaleShotgunWorktrees(cfg, { list: async () => ({ ok: true, value: [{ task, status: 'finalizing', round: 0, startedAt: '', finalization: { mergeCommit: 'abc', branch: 'al/task-shot-2', mergeInto: 'main', behaviorNotified: false, readmeTaskEnsured: false, completionNotified: false, rebaseDone: false, failCount: 0 } }] }) } as never, now);
  expect(result.ok).toBe(true); expect(await present(staleShot)).toBe(true);
});
