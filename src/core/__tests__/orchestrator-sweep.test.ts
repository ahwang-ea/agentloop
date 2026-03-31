import { jest } from '@jest/globals';
import { ok } from '../../shared/result.js';

const architectSweep = jest.fn(async () => ok(undefined));

await jest.unstable_mockModule('../sweep.js', () => ({ architectSweep }));
const { runOrchestrator } = await import('../../orchestrator.js');

const config = {
  repoPath: '.', baseBranch: 'main', branchPrefix: 'al/', worktreeRoot: '.worktrees',
  verifyCommand: './verify.sh', agentsMdPath: 'AGENTS.md', architectureMdPath: 'ARCHITECTURE.md',
  claudeModel: 'claude', codexModel: 'codex', codexEnabled: true, convergence: { maxWallClock: 1, maxTokens: 1, stuckThreshold: 1, thrashOverlapRatio: 0.5 },
  taskSource: 'file' as const, taskFilePath: 'tasks.json', maxParallelAgents: 1, maxTasksPerSession: 3, maxTokensPerSession: 100000, parallelVerify: true, sweepInterval: 0,
};

test('stops cleanly without architect sweep when disabled', async () => {
  const result = await runOrchestrator({
    config,
    queue: { claimNextActionable: async () => ok(null), list: async () => ok([]) },
    notifier: { send: async () => ok(undefined) },
  } as never);
  expect(result.ok).toBe(true);
  expect(architectSweep).not.toHaveBeenCalled();
});
