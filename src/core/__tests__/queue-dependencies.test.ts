import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileTaskQueue } from '../task-queue.js';

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

const readRaw = async (repoPath: string) => {
  const raw = JSON.parse(await readFile(join(repoPath, 'tasks.json'), 'utf-8')) as Array<{ status: string; stuckReason?: string }> | { version: number; tasks: Array<{ status: string; stuckReason?: string }> };
  return Array.isArray(raw) ? raw : raw.tasks;
};

test('claimNextActionable skips queued tasks with unmet dependencies', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-queue-deps-')), queue = createFileTaskQueue(config(repoPath));
  const dep = await queue.add({ title: 'Dependency', description: '', scope: { editableFiles: ['src/a.ts'], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], priority: 'medium' });
  expect(dep.ok).toBe(true);
  if (!dep.ok) return;
  const blocked = await queue.add({ title: 'Blocked', description: '', dependsOn: [dep.value.id], scope: { editableFiles: ['src/b.ts'], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], priority: 'medium' });
  expect(blocked.ok).toBe(true);
  if (!blocked.ok) return;
  const first = await queue.claimNextActionable(2);
  expect(first.ok && first.value?.state.task.id).toBe(dep.value.id);
  if (!first.ok || !first.value || first.value.state.status !== 'writing') return;
  await queue.markDone(dep.value.id, first.value.claimToken);
  const second = await queue.claimNextActionable(2);
  expect(second.ok && second.value?.state.task.id).toBe(blocked.value.id);
});

test('markQueuedStuck only marks queued tasks', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-queue-stuck-')), queue = createFileTaskQueue(config(repoPath));
  const task = await queue.add({ title: 'Queued', description: '', scope: { editableFiles: ['src/a.ts'], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], priority: 'medium' });
  expect(task.ok).toBe(true);
  if (!task.ok) return;
  const stuck = await queue.markQueuedStuck(task.value.id, 'dependency failed');
  expect(stuck.ok).toBe(true);
  const raw = await readRaw(repoPath);
  expect(raw[0]).toMatchObject({ status: 'stuck', stuckReason: 'dependency failed' });
  const rejected = await queue.markQueuedStuck(task.value.id, 'again');
  expect(rejected.ok).toBe(false);
});

test('claimNextActionable defers queued integrate tasks while other claims are active', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-queue-integrate-'));
  const taskFile = join(repoPath, 'tasks.json');
  await writeFile(taskFile, JSON.stringify([
    { task: { id: 'active', title: 'Active', description: '', type: 'implement', scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], priority: 'medium', createdAt: '' }, status: 'writing', round: 0, startedAt: '', claim: { token: 'active-claim', expiresAt: new Date(Date.now() + 60_000).toISOString() } },
    { task: { id: 'integrate', title: 'Integrate', description: '', type: 'integrate', scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], priority: 'medium', createdAt: '' }, status: 'queued', round: 0, startedAt: '' },
  ], null, 2));
  const queue = createFileTaskQueue(config(repoPath));
  const claimed = await queue.claimNextActionable(2);
  expect(claimed.ok ? claimed.value : 'bad').toBeNull();
  const raw = JSON.parse(await readFile(taskFile, 'utf-8')) as Array<{ status: string; claim?: { token: string } }>;
  expect(raw[1].status).toBe('queued');
  expect(raw[1].claim).toBeUndefined();
});

test('claimNextActionable defers expired integrate resumes while other claims are active', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-queue-integrate-'));
  const taskFile = join(repoPath, 'tasks.json');
  await writeFile(taskFile, JSON.stringify([
    { task: { id: 'active', title: 'Active', description: '', type: 'implement', scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], priority: 'medium', createdAt: '' }, status: 'writing', round: 0, startedAt: '', claim: { token: 'active-claim', expiresAt: new Date(Date.now() + 60_000).toISOString() } },
    { task: { id: 'integrate', title: 'Integrate', description: '', type: 'integrate', scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], priority: 'medium', createdAt: '' }, status: 'writing', round: 0, startedAt: '', claim: { token: 'stale-claim', expiresAt: '2026-03-31T00:00:00.000Z' } },
  ], null, 2));
  const queue = createFileTaskQueue(config(repoPath));
  const claimed = await queue.claimNextActionable(2);
  expect(claimed.ok ? claimed.value : 'bad').toBeNull();
  const raw = JSON.parse(await readFile(taskFile, 'utf-8')) as Array<{ status: string; claim?: { token: string } }>;
  expect(raw[1]).toMatchObject({ status: 'writing', claim: { token: 'stale-claim' } });
});


test('reads versioned queue wrappers', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-queue-wrapper-'));
  await writeFile(join(repoPath, 'tasks.json'), JSON.stringify({
    version: 1,
    tasks: [{
      task: { id: 'wrapped', title: 'Wrapped', description: '', type: 'implement', scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], priority: 'medium', createdAt: '2026-04-01T00:00:00.000Z' },
      status: 'queued', round: 0, startedAt: '2026-04-01T00:00:00.000Z',
    }],
  }), 'utf-8');
  const listed = await createFileTaskQueue(config(repoPath)).list();
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  expect(listed.value).toHaveLength(1);
  expect(listed.value[0].task.id).toBe('wrapped');
});
