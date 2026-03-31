import { jest } from '@jest/globals';
import { ok } from '../../shared/result.js';
import { runResearchTask } from '../research-task.js';

const task = {
  id: 'research-1',
  title: 'Research adapter',
  description: 'Find the right API',
  type: 'research' as const,
  scope: { editableFiles: ['src/adapters/payment.ts'], readOnlyContext: [], forbiddenFiles: [] },
  acceptanceCriteria: [],
  priority: 'medium' as const,
  createdAt: '',
};

test('auto-approves research tasks in benchmark mode', async () => {
  const approveBlocked = jest.fn(async () => ok(undefined));
  const queue = { renewClaim: async () => ok(undefined), markBlocked: async () => ok(undefined), approveBlocked, list: async () => ok([{ task, status: 'blocked', round: 0, startedAt: '', blocked: { reason: 'awaiting human approval', details: {}, blockedAt: new Date().toISOString() } }]) };
  const result = await runResearchTask({
    config: { baseBranch: 'main', repoPath: process.cwd(), agentsMdPath: 'AGENTS.md', autoApproveResearch: true },
    claude: { startSession: async () => ok({ id: 's', taskId: task.id }), waitForStop: async () => ok({ text: 'done', changedFiles: ['.agentloop/research/x.md'], tokenEstimate: 1 }), chat: async () => ok({ text: 'No changes needed', tokensDelta: 0, changedFiles: [], stopReason: 'end_turn' }) } as never,
    git: { commit: async () => ok('abc') } as never,
    notifier: { send: async () => ok(undefined) } as never,
    queue: queue as never,
  }, task, 'al/research-1', process.cwd(), 'token');
  expect(result.ok).toBe(true);
  expect(approveBlocked).toHaveBeenCalledWith(task.id);
});

test('keeps research tasks blocked in normal mode', async () => {
  const approveBlocked = jest.fn(async () => ok(undefined));
  const queue = { renewClaim: async () => ok(undefined), markBlocked: async () => ok(undefined), approveBlocked, list: async () => ok([{ task, status: 'blocked', round: 0, startedAt: '', blocked: { reason: 'awaiting human approval', details: {}, blockedAt: new Date().toISOString() } }]) };
  await runResearchTask({
    config: { baseBranch: 'main', repoPath: process.cwd(), agentsMdPath: 'AGENTS.md', autoApproveResearch: false },
    claude: { startSession: async () => ok({ id: 's', taskId: task.id }), waitForStop: async () => ok({ text: 'done', changedFiles: ['.agentloop/research/x.md'], tokenEstimate: 1 }), chat: async () => ok({ text: 'No changes needed', tokensDelta: 0, changedFiles: [], stopReason: 'end_turn' }) } as never,
    git: { commit: async () => ok('abc') } as never,
    notifier: { send: async () => ok(undefined) } as never,
    queue: queue as never,
  }, task, 'al/research-1', process.cwd(), 'token');
  expect(approveBlocked).not.toHaveBeenCalled();
});
