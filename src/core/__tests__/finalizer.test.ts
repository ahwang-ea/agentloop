import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { ok } from '../../shared/result.js';

const gc = jest.fn(async () => ok(undefined));
const refreshLearnings = jest.fn(async () => ok(undefined));
await jest.unstable_mockModule('../gc.js', () => ({ gc }));
await jest.unstable_mockModule('../learnings.js', () => ({ refreshLearnings }));
const { finalize } = await import('../finalizer.js');

const repo = async () => {
  const path = await mkdtemp(join(tmpdir(), 'agentloop-finalizer-'));
  await writeFile(join(path, 'AGENTS.md'), '# AGENTS\n', 'utf-8');
  return path;
};

test('skips README follow-up task when disabled', async () => {
  const repoPath = await repo();
  const ensureTask = jest.fn(async () => ok({ id: 'readme-task' }));
  const result = await finalize({
    config: { repoPath, baseBranch: 'main', agentsMdPath: 'AGENTS.md', readmeTasksEnabled: false } as never,
    claude: {} as never,
    codex: {} as never,
    git: { getDiff: async () => ok('diff --git a/src/routes.ts b/src/routes.ts\n+++ b/src/routes.ts\n+router.get("/")\n'), rebaseAll: async () => ok(undefined) } as never,
    notifier: { send: async () => ok(undefined) } as never,
    queue: { updateFinalization: async () => ok(undefined), ensureTask, markDone: async () => ok(undefined), list: async () => ok([{ task: { id: 'task-1', title: 'Add routes', description: '', type: 'implement', priority: 'medium', createdAt: '2026-03-31T00:00:00.000Z', scope: { editableFiles: ['src/routes.ts'], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [] }, status: 'done', round: 0, startedAt: '', completedAt: '2026-03-31T00:00:00.000Z' }]) } as never,
  }, {
    id: 'task-1', title: 'Add routes', description: '', type: 'implement', priority: 'medium', createdAt: '2026-03-31T00:00:00.000Z',
    scope: { editableFiles: ['src/routes.ts'], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [],
  }, {
    mergeCommit: 'abc', branch: 'al/task-1', mergeInto: 'main', approvalRequested: true, approved: true, featureMerged: true, intentChecked: true,
    behaviorNotified: false, readmeTaskEnsured: false, completionNotified: false, rebaseDone: false, failCount: 0,
  }, 'claim-token');
  expect(result.ok).toBe(true);
  expect(ensureTask).not.toHaveBeenCalled();
  expect(gc).toHaveBeenCalled();
});
