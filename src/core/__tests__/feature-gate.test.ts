import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from '../../shared/result.js';
import { DEFAULT_CONFIG } from '../cli-config.js';
import { prepareFeatureFinalization } from '../feature-gate.js';
import type { FinalizationState, TaskDefinition } from '../../types/index.js';

const task: TaskDefinition = {
  id: 'task-1',
  title: 'Checkout',
  description: 'Feature work',
  feature: 'checkout',
  type: 'implement',
  scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] },
  acceptanceCriteria: [],
  priority: 'medium',
  createdAt: '2026-04-01T00:00:00.000Z',
};

const finalization: FinalizationState = {
  mergeCommit: 'abc',
  branch: 'al/task-1',
  mergeInto: 'main',
  featureBranch: 'feature-checkout',
  behaviorNotified: false,
  readmeTaskEnsured: false,
  completionNotified: false,
  rebaseDone: false,
  failCount: 0,
};

test('prepareFeatureFinalization returns TRANSPORT_ERROR when feature worktree is missing', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-feature-gate-'));
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'agentloop-feature-worktrees-'));
  await mkdir(join(repoPath, '.git'), { recursive: true });
  const result = await prepareFeatureFinalization({
    config: { ...DEFAULT_CONFIG, repoPath, worktreeRoot, autoApproveFeatures: true },
    queue: {
      list: async () => ok([]),
      updateFinalization: async () => ok(undefined),
      markDone: async () => ok(undefined),
      markBlocked: async () => ok(undefined),
    } as never,
    git: {
      checkoutBase: async () => ok(repoPath),
      getDiff: async () => ok(''),
      rebaseAll: async () => ok(undefined),
    } as never,
    notifier: { send: async () => ok(undefined) } as never,
    claude: {} as never,
    codex: {} as never,
  }, task, finalization, 'claim');
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe('TRANSPORT_ERROR');
  expect(result.error.message).toContain('Feature gate worktree missing');
});
