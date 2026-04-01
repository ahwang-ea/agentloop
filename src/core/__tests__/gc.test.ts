import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { archiveOldTasks, gc } from '../gc.js';
import { pruneNotificationKeys } from '../notifier.js';

const repo = () => mkdtemp(join(tmpdir(), 'agentloop-gc-'));
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
const task = { id: 't', title: 'Task', description: '', scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], type: 'implement' as const, priority: 'medium' as const, createdAt: '' };

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
