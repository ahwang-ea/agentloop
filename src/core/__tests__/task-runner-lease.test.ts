import { jest } from '@jest/globals';
import type { ConvergenceState, VerifyResult, WriterOutput } from '../../types/index.js';
import { err, ok } from '../../shared/result.js';

const writerOutput = (text: string, changedFiles: string[], tokenEstimate: number): WriterOutput => ({ text, changedFiles, tokenEstimate });
const verifyResult = (pass: boolean, errors: VerifyResult['errors'] = []): VerifyResult => ({ pass, output: pass ? 'ok' : 'failed', errors, duration: 1 });
const startedWrite = () => ({ session: { id: 'session-1', taskId: 'task-1' }, output: writerOutput('wrote', ['src/result.ts'], 2) });
const reviewPhase = jest.fn(async () => ok(undefined));
const scaffoldTask = jest.fn(async () => ok([]));
const writeCurrentScope = jest.fn(async () => ok(undefined));
const verifyLoop = jest.fn(async () => ok(undefined));
const startWrite = jest.fn(async () => ok(startedWrite()));
const runWriterCleanup = jest.fn(async () => ok(writerOutput('cleanup', [], 1)));
const progressiveVerify = jest.fn(async () => ok(verifyResult(true)));
const commitAndMergeTask = jest.fn(async () => ok(undefined));

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
const ctx = (renewClaim = jest.fn(async () => ok(undefined))) => ({
  d: { config: { reviewEnabled: false } as never, queue: { updateProgress: async () => ok(undefined), updateStatus: async () => ok(undefined), renewClaim }, git: {} as never, claude: {} as never, codex: {} as never, codexWriter: {} as never, notifier: {} as never } as never,
  task, branch: 'al/task-1', mergeInto: 'main', worktreePath: '/tmp/agentloop-task-runner', token: 'claim-token', usage: { session: undefined, tokens: 0 },
});
const state = () => ({ conv: conv(), started: startedWrite(), t0: 1 });
const gate = () => { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; };

beforeEach(() => {
  jest.useFakeTimers();
  reviewPhase.mockReset(); scaffoldTask.mockReset(); writeCurrentScope.mockReset(); verifyLoop.mockReset(); startWrite.mockReset(); runWriterCleanup.mockReset(); progressiveVerify.mockReset(); commitAndMergeTask.mockReset();
  reviewPhase.mockResolvedValue(ok(undefined)); scaffoldTask.mockResolvedValue(ok([])); writeCurrentScope.mockResolvedValue(ok(undefined)); verifyLoop.mockResolvedValue(ok(undefined));
  startWrite.mockResolvedValue(ok(startedWrite())); runWriterCleanup.mockResolvedValue(ok(writerOutput('cleanup', [], 1))); progressiveVerify.mockResolvedValue(ok(verifyResult(true))); commitAndMergeTask.mockResolvedValue(ok(undefined));
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

test('runTaskSetup propagates renewal failures from the initial write lease', async () => {
  const pending = gate(), details = { phase: 'start-renew' };
  startWrite.mockImplementationOnce(async () => { await pending.wait; return ok(startedWrite()); });
  const renewClaim = jest.fn(async () => err('SESSION_ERROR', 'renew setup failed', details));
  const promise = runTaskSetup(ctx(renewClaim) as any, undefined, undefined, false);
  await jest.advanceTimersByTimeAsync(30_001);
  expect(renewClaim).toHaveBeenCalledWith(task.id, 'claim-token');
  pending.release();
  await expect(promise).resolves.toEqual({ ok: false, error: expect.objectContaining({ code: 'SESSION_ERROR', message: 'renew setup failed', details: expect.objectContaining({ ...details, leaseRenewal: true }) }) });
});

test('finishTaskRun propagates renewal failures from the cleanup lease', async () => {
  const pending = gate(), details = { phase: 'cleanup-renew' };
  runWriterCleanup.mockImplementationOnce(async () => { await pending.wait; return ok(writerOutput('cleanup', [], 1)); });
  const renewClaim = jest.fn(async () => err('SESSION_ERROR', 'renew cleanup failed', details));
  const promise = finishTaskRun(ctx(renewClaim) as any, state());
  await jest.advanceTimersByTimeAsync(30_001);
  expect(renewClaim).toHaveBeenCalledWith(task.id, 'claim-token');
  pending.release();
  await expect(promise).resolves.toEqual({ ok: false, error: expect.objectContaining({ code: 'SESSION_ERROR', message: 'renew cleanup failed', details: expect.objectContaining({ ...details, leaseRenewal: true }) }) });
});

test('finishTaskRun propagates renewal failures from final verify', async () => {
  const pending = gate(), details = { phase: 'verify-renew' };
  progressiveVerify.mockImplementationOnce(async () => { await pending.wait; return ok(verifyResult(true)); });
  const renewClaim = jest.fn(async () => err('SESSION_ERROR', 'renew verify failed', details));
  const promise = finishTaskRun(ctx(renewClaim) as any, state());
  await jest.advanceTimersByTimeAsync(30_001);
  expect(renewClaim).toHaveBeenCalledWith(task.id, 'claim-token');
  pending.release();
  await expect(promise).resolves.toEqual({ ok: false, error: expect.objectContaining({ code: 'SESSION_ERROR', message: 'renew verify failed', details: expect.objectContaining({ ...details, leaseRenewal: true }) }) });
  expect(commitAndMergeTask).not.toHaveBeenCalled();
});
