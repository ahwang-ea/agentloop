import { jest } from '@jest/globals';
import { err, ok } from '../../shared/result.js';

const withLease = jest.fn<any>(async (run: () => Promise<unknown>, renew?: () => Promise<unknown>) => {
  if (renew) await renew();
  return run();
});
const runTask = jest.fn<any>();
const mergeCommittedBranch = jest.fn<any>();
const progressiveVerify = jest.fn<any>();

await jest.unstable_mockModule('../lease.js', () => ({ withLease }));
await jest.unstable_mockModule('../task-runner.js', () => ({ runTask }));
await jest.unstable_mockModule('../task-merge.js', () => ({ mergeCommittedBranch }));
await jest.unstable_mockModule('../verifier.js', () => ({ progressiveVerify }));

const { shotgunExecute } = await import('../shotgun.js');

const task = {
  id: 'task-1', title: 'Task', description: 'Do it', type: 'implement' as const,
  scope: { editableFiles: ['src/a.ts'], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], priority: 'medium' as const, createdAt: '',
};
const verifyFail = (count: number) => ok({
  pass: false,
  output: '',
  errors: Array.from({ length: count }, (_unused, index) => ({ source: 'test' as const, message: `e${index}`, hash: `${index}` })),
  duration: 0,
});
const deps = (createBranch = async (name: string) => ok({ name, createdFrom: 'main', worktreePath: `/tmp/${name}` })) => {
  const renewClaim = jest.fn(async () => ok(undefined));
  const updateProgress = jest.fn(async () => ok(undefined));
  const abandonBranch = jest.fn(async () => ok(undefined));
  return { config: { repoPath: '/tmp/repo', verifyCommand: './verify.sh' }, git: { createBranch, abandonBranch }, queue: { renewClaim, updateProgress } };
};

beforeEach(() => {
  withLease.mockReset(); runTask.mockReset(); mergeCommittedBranch.mockReset(); progressiveVerify.mockReset();
  withLease.mockImplementation(async (run: () => Promise<unknown>, renew?: () => Promise<unknown>) => { if (renew) await renew(); return run(); });
  mergeCommittedBranch.mockResolvedValue(ok(undefined));
});
afterEach(() => jest.restoreAllMocks());

test('merges the first successful shotgun candidate, records the winner, and renews the parent claim', async () => {
  runTask.mockImplementation(async (_deps: unknown, _task: unknown, branch: string) => branch.endsWith('-shot-2') ? ok(undefined) : new Promise(resolve => setTimeout(() => resolve(ok(undefined)), 5)));
  const state = deps();
  const result = await shotgunExecute(state as never, task, 'al/task', 'main', '/tmp/al/task', 'claim', 3);
  expect(result.ok).toBe(true);
  expect(state.queue.renewClaim).toHaveBeenCalledWith(task.id, 'claim');
  expect(state.queue.updateProgress).toHaveBeenCalledWith(task.id, expect.objectContaining({ branch: 'al/task-shot-2', convergence: expect.objectContaining({ shotgunWinner: 2 }) }), 'claim');
  expect(mergeCommittedBranch).toHaveBeenCalledWith(expect.anything(), expect.anything(), task, 'al/task-shot-2', 'main', 'claim');
  expect(state.git.abandonBranch).toHaveBeenCalledWith('al/task');
  expect(state.git.abandonBranch).toHaveBeenCalledWith('al/task-shot-3');
});

test('logs fan-out failures before falling back to the best candidate', async () => {
  const stderr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  runTask.mockResolvedValueOnce(err('VERIFY_FAILED', 'first nope')).mockResolvedValueOnce(err('VERIFY_FAILED', 'second nope')).mockResolvedValueOnce(err('VERIFY_FAILED', 'third nope')).mockResolvedValueOnce(ok(undefined));
  progressiveVerify.mockResolvedValueOnce(verifyFail(2)).mockResolvedValueOnce(verifyFail(1)).mockResolvedValueOnce(verifyFail(3));
  const result = await shotgunExecute(deps() as never, task, 'al/task', 'main', '/tmp/al/task', 'claim', 3);
  expect(result.ok).toBe(true);
  expect(stderr.mock.calls.flat().join('\n')).toContain('Shotgun fan-out failed: [1:al/task] VERIFY_FAILED first nope | [2:al/task-shot-2] VERIFY_FAILED second nope | [3:al/task-shot-3] VERIFY_FAILED third nope');
  expect(runTask).toHaveBeenLastCalledWith(expect.anything(), task, 'al/task-shot-2', 'main', '/tmp/al/task-shot-2', undefined, 'claim', undefined, expect.anything(), false);
});

test.each(['STUCK', 'REVIEW_STUCK'] as const)('keeps the best branch when fallback returns %s', async code => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  runTask.mockResolvedValueOnce(err('VERIFY_FAILED', 'first nope')).mockResolvedValueOnce(err('VERIFY_FAILED', 'second nope')).mockResolvedValueOnce(err('VERIFY_FAILED', 'third nope')).mockResolvedValueOnce(err(code, 'hold state'));
  progressiveVerify.mockResolvedValueOnce(verifyFail(2)).mockResolvedValueOnce(verifyFail(1)).mockResolvedValueOnce(verifyFail(3));
  const state = deps();
  const result = await shotgunExecute(state as never, task, 'al/task', 'main', '/tmp/al/task', 'claim', 3);
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code, details: expect.objectContaining({ shotgunFailures: expect.any(Array) }) }) });
  expect(state.git.abandonBranch).toHaveBeenCalledWith('al/task');
  expect(state.git.abandonBranch).toHaveBeenCalledWith('al/task-shot-3');
  expect(state.git.abandonBranch).not.toHaveBeenCalledWith('al/task-shot-2');
});

test('cleans up created shotgun branches when candidate preparation fails', async () => {
  const createBranch = jest.fn<any>(async (name: string) => name.endsWith('-shot-2') ? ok({ name, createdFrom: 'main', worktreePath: `/tmp/${name}` }) : err('GIT_ERROR', 'branch fail'));
  const state = deps(createBranch);
  const result = await shotgunExecute(state as never, task, 'al/task', 'main', '/tmp/al/task', 'claim', 4);
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'GIT_ERROR', message: 'branch fail' }) });
  expect(state.git.abandonBranch).toHaveBeenCalledWith('al/task-shot-2');
  expect(state.git.abandonBranch).not.toHaveBeenCalledWith('al/task');
});
