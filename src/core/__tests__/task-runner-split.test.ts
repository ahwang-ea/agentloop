import { jest } from '@jest/globals';
import type { ConvergenceState, VerifyResult, WriterOutput } from '../../types/index.js';
import { ok } from '../../shared/result.js';

const writerOutput = (text: string, changedFiles: string[], tokenEstimate: number): WriterOutput => ({ text, changedFiles, tokenEstimate });
const verifyResult = (pass: boolean, errors: VerifyResult['errors'] = []): VerifyResult => ({ pass, output: pass ? 'ok' : 'failed', errors, duration: 1 });
const startedWrite = () => ({ session: { id: 'session-1', taskId: 'task-1' }, output: writerOutput('wrote', ['src/result.ts'], 2) });
const withLease = jest.fn(async (run: () => Promise<unknown>) => run());
const reviewPhase = jest.fn(async () => ok(undefined));
const scaffoldTask = jest.fn(async () => ok([]));
const writeCurrentScope = jest.fn(async () => ok(undefined));
const verifyLoop = jest.fn(async () => ok(undefined));
const startWrite = jest.fn(async () => ok(startedWrite()));
const runWriterCleanup = jest.fn(async () => ok(writerOutput('cleanup', [], 1)));
const progressiveVerify = jest.fn(async () => ok(verifyResult(true)));
const commitAndMergeTask = jest.fn(async () => ok(undefined));

await jest.unstable_mockModule('../lease.js', () => ({ withLease }));
await jest.unstable_mockModule('../review-loop.js', () => ({ reviewPhase }));
await jest.unstable_mockModule('../scaffold.js', () => ({ scaffoldTask }));
await jest.unstable_mockModule('../scope-file.js', () => ({ writeCurrentScope }));
await jest.unstable_mockModule('../verify-loop.js', () => ({ verifyLoop }));
await jest.unstable_mockModule('../writer.js', () => ({ startWrite, runWriterCleanup }));
await jest.unstable_mockModule('../verifier.js', () => ({ progressiveVerify }));
await jest.unstable_mockModule('../task-merge.js', () => ({ commitAndMergeTask }));

const { runTaskSetup } = await import('../task-runner-setup.js');
const { finishTaskRun } = await import('../task-runner-finish.js');

const task = { id: 'task-1', title: 'Define result type', description: '', type: 'implement' as const, scope: { editableFiles: ['src/result.ts'], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], priority: 'medium' as const, createdAt: '2026-03-31T00:00:00.000Z' };
const conv = (): ConvergenceState => ({ rounds: [], classification: 'unknown', webSearchTriggered: false, reviewFindings: 0, errorTypes: [], changedFiles: ['src/result.ts'] });
const ctx = (statuses: string[], reviewEnabled = true, renews: string[] = []) => ({
  d: {
    config: { reviewEnabled } as never,
    queue: {
      updateProgress: async () => ok(undefined),
      updateStatus: async (_id: string, status: string) => (statuses.push(status), ok(undefined)),
      renewClaim: async (_taskId: string, token: string) => (renews.push(token), ok(undefined)),
    },
    git: {} as never,
    claude: {} as never,
    codex: {} as never,
    codexWriter: {} as never,
    notifier: {} as never,
  } as never,
  task,
  branch: 'al/task-1',
  mergeInto: 'main',
  worktreePath: '/tmp/agentloop-task-runner',
  token: 'claim-token',
  usage: { session: undefined, tokens: 0 },
});
const state = () => ({ conv: conv(), started: startedWrite(), t0: 1 });

beforeEach(() => {
  withLease.mockReset(); reviewPhase.mockReset(); scaffoldTask.mockReset(); writeCurrentScope.mockReset();
  verifyLoop.mockReset(); startWrite.mockReset(); runWriterCleanup.mockReset(); progressiveVerify.mockReset(); commitAndMergeTask.mockReset();
  withLease.mockImplementation(async (run: () => Promise<unknown>) => run());
  reviewPhase.mockResolvedValue(ok(undefined));
  scaffoldTask.mockResolvedValue(ok([]));
  writeCurrentScope.mockResolvedValue(ok(undefined));
  verifyLoop.mockResolvedValue(ok(undefined));
  startWrite.mockResolvedValue(ok(startedWrite()));
  runWriterCleanup.mockResolvedValue(ok(writerOutput('cleanup', [], 1)));
  progressiveVerify.mockResolvedValue(ok(verifyResult(true)));
  commitAndMergeTask.mockResolvedValue(ok(undefined));
});

test('runTaskSetup keeps the review-enabled path flowing through review', async () => {
  const statuses: string[] = [];
  const result = await runTaskSetup(ctx(statuses), undefined, undefined, false);
  expect(result.ok).toBe(true);
  expect(verifyLoop).toHaveBeenCalledTimes(1);
  expect(reviewPhase).toHaveBeenCalledWith(expect.anything(), { id: 'session-1', taskId: 'task-1' }, task, expect.anything(), expect.any(Number), '/tmp/agentloop-task-runner', 'claim-token', expect.objectContaining({ tokens: 2 }));
  expect(statuses).toEqual(['verifying', 'reviewing']);
});

test('finishTaskRun skips the second iterative verify when cleanup is a no-op', async () => {
  const statuses: string[] = [];
  const result = await finishTaskRun(ctx(statuses), state());
  expect(result.ok).toBe(true);
  expect(verifyLoop).not.toHaveBeenCalled();
  expect(progressiveVerify).toHaveBeenCalledWith(expect.anything(), ['src/result.ts'], '/tmp/agentloop-task-runner', true, 'implement');
  expect(statuses).toEqual(['cleanup', 'merging']);
});

test('finishTaskRun renews the lease during final merge verify', async () => {
  const statuses: string[] = [], renews: string[] = [];
  withLease.mockImplementation(async (run: () => Promise<unknown>, renew?: () => Promise<unknown>) => {
    if (renew) await renew();
    return run();
  });
  const result = await finishTaskRun(ctx(statuses, true, renews), state());
  expect(result.ok).toBe(true);
  expect(renews).toEqual(['claim-token', 'claim-token']);
  expect(withLease).toHaveBeenCalledTimes(2);
});

test('finishTaskRun blocks merge when final merge verify fails', async () => {
  const statuses: string[] = [];
  progressiveVerify.mockResolvedValueOnce(ok(verifyResult(false, [{ source: 'test', message: 'broken test', hash: 'err-1' }])));
  const result = await finishTaskRun(ctx(statuses), state());
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VERIFY_FAILED', message: 'Final verify failed before merge' }) });
  expect(commitAndMergeTask).not.toHaveBeenCalled();
  expect(statuses).toEqual(['cleanup']);
});

test('finishTaskRun reaches merge after cleanup changes verify cleanly', async () => {
  const statuses: string[] = [];
  runWriterCleanup.mockResolvedValueOnce(ok(writerOutput('cleanup', ['src/result.ts'], 3)));
  const result = await finishTaskRun(ctx(statuses), state());
  expect(result.ok).toBe(true);
  expect(verifyLoop).toHaveBeenCalledWith(expect.anything(), { id: 'session-1', taskId: 'task-1' }, task, 3, ['src/result.ts'], expect.anything(), 1, '/tmp/agentloop-task-runner', 'claim-token', expect.objectContaining({ tokens: 3 }));
  expect(commitAndMergeTask).toHaveBeenCalledWith(expect.anything(), expect.anything(), task, 'al/task-1', 'main', 'claim-token', 'feat: Define result type');
  expect(statuses).toEqual(['cleanup', 'verifying', 'merging']);
});
