import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const repo = () => mkdtemp(join(tmpdir(), 'agentloop-research-'));
const queue = (approveBlocked = jest.fn(async () => ok(undefined))) => ({
  renewClaim: async () => ok(undefined),
  markBlocked: async () => ok(undefined),
  approveBlocked,
  list: async () => ok([{ task, status: 'blocked', round: 0, startedAt: '', blocked: { reason: 'awaiting human approval', details: {}, blockedAt: new Date().toISOString() } }]),
});

test('auto-approves research tasks in benchmark mode', async () => {
  const cwd = await repo();
  try {
    const approveBlocked = jest.fn(async () => ok(undefined));
    const result = await runResearchTask({
      config: { baseBranch: 'main', repoPath: cwd, agentsMdPath: 'AGENTS.md', autoApproveResearch: true },
      claude: { startSession: async () => ok({ id: 's', taskId: task.id }), waitForStop: async () => ok({ text: 'done', changedFiles: ['.agentloop/research/x.md'], tokenEstimate: 1 }), chat: async () => ok({ text: 'No changes needed', tokensDelta: 0, changedFiles: [], stopReason: 'end_turn' }) } as never,
      git: { commit: async () => ok('abc') } as never,
      notifier: { send: async () => ok(undefined) } as never,
      queue: queue(approveBlocked) as never,
    }, task, 'al/research-1', cwd, 'token');
    expect(result.ok).toBe(true);
    expect(approveBlocked).toHaveBeenCalledWith(task.id);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('keeps research tasks blocked in normal mode', async () => {
  const cwd = await repo();
  try {
    const approveBlocked = jest.fn(async () => ok(undefined));
    await runResearchTask({
      config: { baseBranch: 'main', repoPath: cwd, agentsMdPath: 'AGENTS.md', autoApproveResearch: false },
      claude: { startSession: async () => ok({ id: 's', taskId: task.id }), waitForStop: async () => ok({ text: 'done', changedFiles: ['.agentloop/research/x.md'], tokenEstimate: 1 }), chat: async () => ok({ text: 'No changes needed', tokensDelta: 0, changedFiles: [], stopReason: 'end_turn' }) } as never,
      git: { commit: async () => ok('abc') } as never,
      notifier: { send: async () => ok(undefined) } as never,
      queue: queue(approveBlocked) as never,
    }, task, 'al/research-1', cwd, 'token');
    expect(approveBlocked).not.toHaveBeenCalled();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('writes live scope state for research sessions', async () => {
  const cwd = await repo();
  try {
    const result = await runResearchTask({
      config: { baseBranch: 'main', repoPath: cwd, agentsMdPath: 'AGENTS.md', autoApproveResearch: false },
      claude: { startSession: async () => ok({ id: 's', taskId: task.id }), waitForStop: async () => ok({ text: 'done', changedFiles: ['.agentloop/research/x.md'], tokenEstimate: 1 }), chat: async () => ok({ text: 'No changes needed', tokensDelta: 0, changedFiles: [], stopReason: 'end_turn' }) } as never,
      git: { commit: async () => ok('abc') } as never,
      notifier: { send: async () => ok(undefined) } as never,
      queue: queue() as never,
    }, task, 'al/research-1', cwd, 'token');
    expect(result.ok).toBe(true);
    const scope = JSON.parse(await readFile(join(cwd, '.agentloop', 'current-scope.json'), 'utf-8')) as Record<string, unknown>;
    expect(scope).toEqual(expect.objectContaining({ version: 1, taskId: task.id, phase: 'research' }));
    expect(scope.editableFiles).toEqual(expect.arrayContaining(['.agentloop/research/**/*', 'ARCHITECTURE.md', 'src/adapters/**/*']));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
