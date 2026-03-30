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
  taskSource: 'file' as const, taskFilePath: 'tasks.json', maxParallelAgents: 2, parallelVerify: true, sweepInterval: 1,
});

test('approves blocked finalization tasks back into finalizing', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-queue-'));
  const queue = createFileTaskQueue(config(repoPath));
  const task = await queue.add({ title: 'Feature gate', description: '', feature: 'checkout', scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], model: 'auto', priority: 'medium' });
  expect(task.ok).toBe(true);
  if (!task.ok) return;
  const claimed = await queue.claimNextActionable(1);
  expect(claimed.ok && claimed.value).toBeTruthy();
  if (!claimed.ok || !claimed.value || claimed.value.state.status !== 'writing') return;
  await queue.beginFinalization(task.value.id, {
    mergeCommit: 'abc', branch: 'al/x', mergeInto: 'al/feature-checkout', featureBranch: 'al/feature-checkout', approvalRequested: true,
    featureMerged: false, intentChecked: false, behaviorNotified: false, readmeTaskEnsured: false, completionNotified: false, rebaseDone: false, failCount: 0,
  }, claimed.value.claimToken);
  const reClaimed = await queue.claimNextActionable(1);
  expect(reClaimed.ok && reClaimed.value?.state.status === 'finalizing').toBe(true);
  if (!reClaimed.ok || !reClaimed.value || reClaimed.value.state.status !== 'finalizing') return;
  await queue.markBlocked(task.value.id, 'Awaiting human approval', {}, reClaimed.value.claimToken);
  const approved = await queue.approveBlocked(task.value.id);
  expect(approved.ok).toBe(true);
  const raw = JSON.parse(await readFile(join(repoPath, 'tasks.json'), 'utf-8')) as Array<{ status: string; finalization?: { approved?: boolean } }>;
  expect(raw[0].status).toBe('finalizing');
  expect(raw[0].finalization?.approved).toBe(true);
});

test('claims only one finalizing task at a time', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-finalizing-'));
  const taskFile = join(repoPath, 'tasks.json');
  await writeFile(taskFile, JSON.stringify([
    {
      task: { id: 'a', title: 'A', description: '', scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], model: 'auto', priority: 'medium', createdAt: '' },
      status: 'finalizing', round: 0, startedAt: '', finalization: { mergeCommit: 'a', branch: 'al/a', mergeInto: 'main', behaviorNotified: false, readmeTaskEnsured: false, completionNotified: false, rebaseDone: false, failCount: 0 },
      claim: { token: 'held', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    },
    {
      task: { id: 'b', title: 'B', description: '', scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], model: 'auto', priority: 'medium', createdAt: '' },
      status: 'finalizing', round: 0, startedAt: '', finalization: { mergeCommit: 'b', branch: 'al/b', mergeInto: 'main', behaviorNotified: false, readmeTaskEnsured: false, completionNotified: false, rebaseDone: false, failCount: 0 },
    },
  ], null, 2));
  const queue = createFileTaskQueue(config(repoPath));
  const claimed = await queue.claimNextActionable(2);
  expect(claimed.ok ? claimed.value : 'bad').toBeNull();
});
