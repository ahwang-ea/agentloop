import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileTaskQueue } from '../task-queue.js';
import { loadTaskQueue, saveTaskQueue } from '../task-queue-store.js';

const taskRecord = (id: string) => ({
  task: {
    id,
    title: `Task ${id}`,
    description: '',
    type: 'implement' as const,
    scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] },
    acceptanceCriteria: [],
    priority: 'medium' as const,
    createdAt: '2026-04-01T00:00:00.000Z',
  },
  status: 'queued' as const,
  round: 0,
  startedAt: '2026-04-01T00:00:00.000Z',
});
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
  taskSource: 'file' as const, taskFilePath: 'tasks.json', maxParallelAgents: 1, maxTasksPerSession: 3, maxTokensPerSession: 100000, parallelVerify: true, sweepInterval: 1,
});
const taskInput = { title: 'Queue task', description: '', scope: { editableFiles: ['src/a.ts'], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], priority: 'medium' as const };

test('missing queue files default to a wrapped queue envelope', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-queue-store-'));
  const taskFile = join(repoPath, 'tasks.json');
  const loaded = await loadTaskQueue(taskFile);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  expect(loaded.value).toEqual({ version: 1, tasks: [] });
  const saved = await saveTaskQueue(taskFile, loaded.value);
  expect(saved.ok).toBe(true);
  const raw = JSON.parse(await readFile(taskFile, 'utf-8')) as { version: number; tasks: [] };
  expect(raw).toEqual({ version: 1, tasks: [] });
});

test('adapter writes keep new queue files wrapped', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-queue-store-'));
  const queue = createFileTaskQueue(config(repoPath));
  const added = await queue.add(taskInput);
  expect(added.ok).toBe(true);
  if (!added.ok) return;
  const claimed = await queue.claimNextActionable(1);
  expect(claimed.ok && claimed.value?.state.status).toBe('writing');
  if (!claimed.ok || !claimed.value || claimed.value.state.status !== 'writing') return;
  const done = await queue.markDone(added.value.id, claimed.value.claimToken);
  expect(done.ok).toBe(true);
  const raw = JSON.parse(await readFile(join(repoPath, 'tasks.json'), 'utf-8')) as { version: number; tasks: Array<{ status: string }> };
  expect(raw.version).toBe(1);
  expect(raw.tasks[0].status).toBe('done');
});

test('saveTaskQueue preserves wrapped queue files', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-queue-store-'));
  const taskFile = join(repoPath, 'tasks.json');
  await writeFile(taskFile, JSON.stringify({ version: 1, tasks: [taskRecord('wrapped')] }, null, 2), 'utf-8');
  const loaded = await loadTaskQueue(taskFile);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  expect(loaded.value.version).toBe(1);
  loaded.value.tasks[0].status = 'stuck';
  loaded.value.tasks[0].stuckReason = 'dependency failed';
  const saved = await saveTaskQueue(taskFile, loaded.value);
  expect(saved.ok).toBe(true);
  const raw = JSON.parse(await readFile(taskFile, 'utf-8')) as { version: number; tasks: Array<{ status: string; stuckReason?: string }> };
  expect(raw.version).toBe(1);
  expect(raw.tasks[0]).toMatchObject({ status: 'stuck', stuckReason: 'dependency failed' });
});

test('saveTaskQueue keeps legacy queue arrays bare', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-queue-store-'));
  const taskFile = join(repoPath, 'tasks.json');
  await writeFile(taskFile, JSON.stringify([taskRecord('legacy')], null, 2), 'utf-8');
  const loaded = await loadTaskQueue(taskFile);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  expect(loaded.value.version).toBeUndefined();
  loaded.value.tasks[0].status = 'done';
  const saved = await saveTaskQueue(taskFile, loaded.value);
  expect(saved.ok).toBe(true);
  const raw = JSON.parse(await readFile(taskFile, 'utf-8')) as Array<{ status: string }>;
  expect(Array.isArray(raw)).toBe(true);
  expect(raw[0].status).toBe('done');
});
