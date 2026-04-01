import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileTaskQueue } from '../task-queue.js';

type QueueRecord = {
  status: string;
  round: number;
  blocked?: { reason: string };
  completedAt?: string;
  convergence?: unknown;
  claim?: { token: string; expiresAt: string };
};
type QueueFile = QueueRecord[] | { version: number; tasks: QueueRecord[] };

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
const readRawQueue = async (repoPath: string) => {
  const raw = JSON.parse(await readFile(join(repoPath, 'tasks.json'), 'utf-8')) as QueueFile;
  return { raw, records: Array.isArray(raw) ? raw : raw.tasks };
};

test('requeueBlocked rejects tasks that are not blocked', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-queue-requeue-'));
  const queue = createFileTaskQueue(config(repoPath));
  const task = await queue.add(taskInput);
  expect(task.ok).toBe(true);
  if (!task.ok) return;
  const rejected = await queue.requeueBlocked(task.value.id);
  expect(rejected.ok).toBe(false);
  if (rejected.ok) return;
  expect(rejected.error.code).toBe('CONFIG_ERROR');
  expect((await readRawQueue(repoPath)).records[0]).toMatchObject({ status: 'queued', round: 0 });
});

test('requeueBlocked resets blocked task state back to queued', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-queue-requeue-'));
  const queue = createFileTaskQueue(config(repoPath));
  const task = await queue.add(taskInput);
  expect(task.ok).toBe(true);
  if (!task.ok) return;
  const claimed = await queue.claimNextActionable(1);
  expect(claimed.ok && claimed.value?.state.status).toBe('writing');
  if (!claimed.ok || !claimed.value || claimed.value.state.status !== 'writing') return;
  const saved = await queue.updateProgress(task.value.id, {
    branch: 'al/queue-task',
    round: 2,
    convergence: { rounds: [], classification: 'converging', webSearchTriggered: false, reviewFindings: 0, errorTypes: [], changedFiles: [] },
  }, claimed.value.claimToken);
  expect(saved.ok).toBe(true);
  const blocked = await queue.markBlocked(task.value.id, 'Need human input', { kind: 'needs-human' }, claimed.value.claimToken);
  expect(blocked.ok).toBe(true);
  const requeued = await queue.requeueBlocked(task.value.id);
  expect(requeued.ok).toBe(true);
  const raw = (await readRawQueue(repoPath)).records[0];
  expect(raw).toMatchObject({ status: 'queued', round: 0 });
  expect(raw.blocked).toBeUndefined();
  expect(raw.completedAt).toBeUndefined();
  expect(raw.convergence).toBeUndefined();
  expect(raw.claim).toBeUndefined();
});

for (const [name, run] of [
  ['updateStatus', (queue: ReturnType<typeof createFileTaskQueue>, taskId: string) => queue.updateStatus(taskId, 'verifying', 'wrong-token')],
  ['updateProgress', (queue: ReturnType<typeof createFileTaskQueue>, taskId: string) => queue.updateProgress(taskId, { branch: 'al/queue-task', round: 1, convergence: undefined }, 'wrong-token')],
  ['markDone', (queue: ReturnType<typeof createFileTaskQueue>, taskId: string) => queue.markDone(taskId, 'wrong-token')],
  ['markBlocked', (queue: ReturnType<typeof createFileTaskQueue>, taskId: string) => queue.markBlocked(taskId, 'Need input', {}, 'wrong-token')],
  ['releaseClaim', (queue: ReturnType<typeof createFileTaskQueue>, taskId: string) => queue.releaseClaim(taskId, 'wrong-token')],
] as const) {
  test(`rejects invalid claim for ${name}`, async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-queue-claim-'));
    const queue = createFileTaskQueue(config(repoPath));
    const task = await queue.add(taskInput);
    expect(task.ok).toBe(true);
    if (!task.ok) return;
    const claimed = await queue.claimNextActionable(1);
    expect(claimed.ok && claimed.value?.state.status).toBe('writing');
    if (!claimed.ok || !claimed.value || claimed.value.state.status !== 'writing') return;
    const rejected = await run(queue, task.value.id);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe('SESSION_ERROR');
    const raw = (await readRawQueue(repoPath)).records[0];
    expect(raw.status).toBe('writing');
    expect(raw.claim?.token).toBe(claimed.value.claimToken);
    expect((await queue.renewClaim(task.value.id, claimed.value.claimToken)).ok).toBe(true);
  });
}

test('rejects expired claims until the task is reclaimed', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-queue-expired-'));
  const taskFile = join(repoPath, 'tasks.json');
  const queue = createFileTaskQueue(config(repoPath));
  const task = await queue.add(taskInput);
  expect(task.ok).toBe(true);
  if (!task.ok) return;
  const claimed = await queue.claimNextActionable(1);
  expect(claimed.ok && claimed.value?.state.status).toBe('writing');
  if (!claimed.ok || !claimed.value || claimed.value.state.status !== 'writing') return;
  const persisted = await readRawQueue(repoPath);
  persisted.records[0].claim = { token: claimed.value.claimToken, expiresAt: '2026-03-31T00:00:00.000Z' };
  await writeFile(taskFile, JSON.stringify(persisted.raw, null, 2));
  const rejected = await queue.updateStatus(task.value.id, 'verifying', claimed.value.claimToken);
  expect(rejected.ok).toBe(false);
  if (rejected.ok) return;
  expect(rejected.error.code).toBe('SESSION_ERROR');
  const reclaimed = await queue.claimNextActionable(1);
  expect(reclaimed.ok && reclaimed.value?.state.task.id).toBe(task.value.id);
});
