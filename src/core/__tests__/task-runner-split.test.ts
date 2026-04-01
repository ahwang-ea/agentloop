import { jest } from '@jest/globals';
import type { ConvergenceState, VerifyResult, WriterOutput } from '../../types/index.js';
import { err, ok } from '../../shared/result.js';

const writerOutput = (text: string, changedFiles: string[], tokenEstimate: number): WriterOutput => ({ text, changedFiles, tokenEstimate });
const verifyResult = (pass: boolean, errors: VerifyResult['errors'] = []): VerifyResult => ({ pass, output: pass ? 'ok' : 'failed', errors, duration: 1 });
const startedWrite = () => ({ session: { id: 'session-1', taskId: 'task-1' }, output: writerOutput('wrote', ['src/result.ts'], 2) });
const queueError = (message: string) => err('QUEUE_CORRUPT', message);
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
  d: { config: { reviewEnabled } as never, queue: { updateProgress: async () => ok(undefined), updateStatus: async (_id: string, status: string) => (statuses.push(status), ok(undefined)), renewClaim: async (_id: string, token: string) => (renews.push(token), ok(undefined)) }, git: {} as never, claude: {} as never, codex: {} as never, codexWriter: {} as never, notifier: {} as never } as never,
  task, branch: 'al/task-1', mergeInto: 'main', worktreePath: '/tmp/agentloop-task-runner', token: 'claim-token', usage: { session: undefined, tokens: 0 },
});
const state = () => ({ conv: conv(), started: startedWrite(), t0: 1 });
const setupFailureCases: Array<[string, (d: any) => void, string, string]> = [
  ['write scope', () => writeCurrentScope.mockResolvedValueOnce(err('TRANSPORT_ERROR', 'scope failed')), 'TRANSPORT_ERROR', 'scope failed'],
  ['initial write', () => startWrite.mockResolvedValueOnce(err('TRANSPORT_ERROR', 'write failed')), 'TRANSPORT_ERROR', 'write failed'],
  ['initial progress', d => { d.d.queue.updateProgress = async () => queueError('progress failed'); }, 'QUEUE_CORRUPT', 'progress failed'],
  ['verifying status', d => { d.d.queue.updateStatus = async () => queueError('status failed'); }, 'QUEUE_CORRUPT', 'status failed'],
];
const finishStatusCases: Array<[string, (d: any) => void, string]> = [
  ['cleanup', d => { d.d.queue.updateStatus = async (_id: string, status: string) => status === 'cleanup' ? queueError('cleanup failed') : ok(undefined); }, 'cleanup failed'],
  ['cleanup verify', d => { runWriterCleanup.mockResolvedValueOnce(ok(writerOutput('cleanup', ['src/result.ts'], 3))); d.d.queue.updateStatus = async (_id: string, status: string) => status === 'verifying' ? queueError('cleanup verify status failed') : ok(undefined); }, 'cleanup verify status failed'],
  ['merging', d => { d.d.queue.updateStatus = async (_id: string, status: string) => status === 'merging' ? queueError('merge status failed') : ok(undefined); }, 'merge status failed'],
];

beforeEach(() => {
  withLease.mockReset(); reviewPhase.mockReset(); scaffoldTask.mockReset(); writeCurrentScope.mockReset(); verifyLoop.mockReset(); startWrite.mockReset(); runWriterCleanup.mockReset(); progressiveVerify.mockReset(); commitAndMergeTask.mockReset();
  withLease.mockImplementation(async (run: () => Promise<unknown>) => run()); reviewPhase.mockResolvedValue(ok(undefined)); scaffoldTask.mockResolvedValue(ok([])); writeCurrentScope.mockResolvedValue(ok(undefined)); verifyLoop.mockResolvedValue(ok(undefined));
  startWrite.mockResolvedValue(ok(startedWrite())); runWriterCleanup.mockResolvedValue(ok(writerOutput('cleanup', [], 1))); progressiveVerify.mockResolvedValue(ok(verifyResult(true))); commitAndMergeTask.mockResolvedValue(ok(undefined));
});
afterEach(() => jest.restoreAllMocks());

test('runTaskSetup reaches review when enabled', async () => {
  const statuses: string[] = [], result = await runTaskSetup(ctx(statuses), undefined, undefined, false);
  expect(result.ok).toBe(true); expect(verifyLoop).toHaveBeenCalledTimes(1); expect(reviewPhase).toHaveBeenCalledWith(expect.anything(), { id: 'session-1', taskId: 'task-1' }, task, expect.anything(), expect.any(Number), '/tmp/agentloop-task-runner', 'claim-token', expect.objectContaining({ tokens: 2 }));
  expect(statuses).toEqual(['verifying', 'reviewing']);
});

test('runTaskSetup records scaffold failures before continuing', async () => {
  const statuses: string[] = [], d = ctx(statuses) as any, progress = jest.fn(async () => ok(undefined));
  scaffoldTask.mockResolvedValueOnce(err('SESSION_ERROR', 'bad scaffold')); d.d.queue.updateProgress = progress; jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const result = await runTaskSetup(d, undefined, undefined, true);
  expect(result.ok).toBe(true); expect(progress).toHaveBeenCalledWith(task.id, expect.objectContaining({ branch: 'al/task-1', round: 0, convergence: expect.objectContaining({ errorTypes: ['scaffold_bad_scaffold'] }) }), 'claim-token');
  expect(statuses).toEqual(['verifying', 'reviewing']);
});

test.each(setupFailureCases)('runTaskSetup propagates %s failures', async (_label, tweak, code, message) => {
  const d = ctx([]) as any; tweak(d);
  const result = await runTaskSetup(d, undefined, undefined, false);
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code, message }) }); expect(verifyLoop).not.toHaveBeenCalled();
});

test.each(finishStatusCases)('finishTaskRun propagates %s status failures', async (_label, tweak, message) => {
  const d = ctx([]) as any; tweak(d);
  const result = await finishTaskRun(d, state());
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'QUEUE_CORRUPT', message }) }); expect(commitAndMergeTask).not.toHaveBeenCalled();
});

test('finishTaskRun propagates cleanup scope failures', async () => {
  writeCurrentScope.mockResolvedValueOnce(err('TRANSPORT_ERROR', 'cleanup scope failed'));
  const result = await finishTaskRun(ctx([]) as any, state());
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'TRANSPORT_ERROR', message: 'cleanup scope failed' }) }); expect(runWriterCleanup).not.toHaveBeenCalled();
});

test('finishTaskRun propagates cleanup writer and verify failures', async () => {
  runWriterCleanup.mockResolvedValueOnce(err('SESSION_ERROR', 'cleanup failed'));
  let result = await finishTaskRun(ctx([]) as any, state());
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'SESSION_ERROR', message: 'cleanup failed' }) }); expect(progressiveVerify).not.toHaveBeenCalled();
  runWriterCleanup.mockResolvedValueOnce(ok(writerOutput('cleanup', ['src/result.ts'], 3))); verifyLoop.mockResolvedValueOnce(err('VERIFY_FAILED', 'cleanup verify failed'));
  result = await finishTaskRun(ctx([]) as any, state());
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VERIFY_FAILED', message: 'cleanup verify failed' }) }); expect(commitAndMergeTask).not.toHaveBeenCalled();
});

test('finishTaskRun propagates cleanup progress and final verify failures', async () => {
  const d = ctx([]) as any; d.d.queue.updateProgress = async () => queueError('progress failed');
  let result = await finishTaskRun(d, state());
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'QUEUE_CORRUPT', message: 'progress failed' }) }); expect(progressiveVerify).not.toHaveBeenCalled();
  progressiveVerify.mockResolvedValueOnce(err('VERIFY_FAILED', 'verify crashed')); result = await finishTaskRun(ctx([]) as any, state());
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VERIFY_FAILED', message: 'verify crashed' }) }); expect(commitAndMergeTask).not.toHaveBeenCalled();
});

test('finishTaskRun blocks merge on verify failure and reaches merge after cleanup verify', async () => {
  progressiveVerify.mockResolvedValueOnce(ok(verifyResult(false, [{ source: 'test', message: 'broken test', hash: 'err-1' }])));
  let result = await finishTaskRun(ctx([]) as any, state());
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VERIFY_FAILED', message: 'Final verify failed before merge' }) }); expect(commitAndMergeTask).not.toHaveBeenCalled();
  runWriterCleanup.mockResolvedValueOnce(ok(writerOutput('cleanup', ['src/result.ts'], 3))); result = await finishTaskRun(ctx([]) as any, state());
  expect(result.ok).toBe(true); expect(verifyLoop).toHaveBeenCalledWith(expect.anything(), { id: 'session-1', taskId: 'task-1' }, task, 3, ['src/result.ts'], expect.anything(), 1, '/tmp/agentloop-task-runner', 'claim-token', expect.objectContaining({ tokens: 3 }));
  expect(commitAndMergeTask).toHaveBeenCalledWith(expect.anything(), expect.anything(), task, 'al/task-1', 'main', 'claim-token', 'feat: Define result type');
});
