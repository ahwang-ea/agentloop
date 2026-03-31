import { mkdtemp, readFile } from 'node:fs/promises';
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
  const raw = JSON.parse(await readFile(join(repoPath, 'tasks.json'), 'utf-8')) as Array<{ status: string; stuckReason?: string }>;
  expect(raw[0]).toMatchObject({ status: 'stuck', stuckReason: 'dependency failed' });
  const rejected = await queue.markQueuedStuck(task.value.id, 'again');
  expect(rejected.ok).toBe(false);
});
