import { jest } from '@jest/globals';

const execFile = jest.fn(), exec: jest.Mock<(...args: unknown[]) => Promise<{ stdout: string; stderr: string }>> = jest.fn();
(execFile as typeof execFile & { [key: symbol]: unknown })[Symbol.for('nodejs.util.promisify.custom')] = exec;
await jest.unstable_mockModule('node:child_process', () => ({ execFile }));
const { verifyAndRetry } = await import('../benchmark-verify-loop.js');

const deps = { queue: { list: async () => [] }, config: {} };
const log = jest.fn(), runOrchestrator = jest.fn(async () => ({ ok: true }));

beforeEach(() => {
  exec.mockReset();
  log.mockReset();
  runOrchestrator.mockReset();
  runOrchestrator.mockResolvedValue({ ok: true });
});

afterEach(() => jest.restoreAllMocks());

test('returns success without retry when tests pass', async () => {
  exec.mockResolvedValueOnce({ stdout: '', stderr: '' });
  await expect(verifyAndRetry('/repo', deps, runOrchestrator, Date.now() + 400_000, log)).resolves.toEqual({ retried: false, testsPassed: true });
  expect(exec).toHaveBeenCalledWith(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test', '--', '--maxWorkers=100%', '--testPathIgnorePatterns', 'golden\\.test\\.ts$'], { cwd: '/repo', timeout: 180_000 });
  expect(runOrchestrator).not.toHaveBeenCalled();
});

test('retries orchestrator when tests fail with enough time remaining', async () => {
  exec.mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce({ stdout: '', stderr: '' });
  await expect(verifyAndRetry('/repo', deps, runOrchestrator, Date.now() + 400_000, log)).resolves.toEqual({ retried: true, testsPassed: true });
  expect(log).toHaveBeenCalledWith('tests failed, retrying orchestrator with remaining budget');
  expect(runOrchestrator).toHaveBeenCalledWith(deps, expect.any(Number));
  expect(exec).toHaveBeenCalledTimes(2);
});

test('returns failure without retry when budget is too low', async () => {
  exec.mockRejectedValueOnce(new Error('fail'));
  await expect(verifyAndRetry('/repo', deps, runOrchestrator, Date.now() + 180_000, log)).resolves.toEqual({ retried: false, testsPassed: false });
  expect(runOrchestrator).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});
