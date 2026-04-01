import { jest } from '@jest/globals';
import { err, ok } from '../../shared/result.js';

const loadConfig = jest.fn(async () => ok({ repoPath: '.', autoApproveResearch: true }));
const runStartPreflight = jest.fn(async () => ok(undefined));
const createDeps = jest.fn(async () => ok({} as never));
const enqueueInteractiveTask = jest.fn(async () => ok(undefined));
const runOrchestrator = jest.fn(async () => ok(undefined));

await jest.unstable_mockModule('../cli-config.js', () => ({ DEFAULT_CONFIG: {}, loadConfig }));
await jest.unstable_mockModule('../preflight.js', () => ({ runStartPreflight, runBenchmarkPreflight: jest.fn(async () => ok(undefined)), runBenchmarkRepoSmokeTest: jest.fn(async () => ok(undefined)) }));
await jest.unstable_mockModule('../deps.js', () => ({ createDeps }));
await jest.unstable_mockModule('../interactive-task.js', () => ({ enqueueInteractiveTask }));
await jest.unstable_mockModule('../../orchestrator.js', () => ({ runOrchestrator }));
const { handleStart } = await import('../cli-commands.js');

beforeEach(() => {
  loadConfig.mockReset();
  runStartPreflight.mockReset();
  createDeps.mockReset();
  enqueueInteractiveTask.mockReset();
  runOrchestrator.mockReset();
  loadConfig.mockResolvedValue(ok({ repoPath: '.', autoApproveResearch: true }));
  runStartPreflight.mockResolvedValue(ok(undefined));
  createDeps.mockResolvedValue(ok({} as never));
  enqueueInteractiveTask.mockResolvedValue(ok(undefined));
  runOrchestrator.mockResolvedValue(ok(undefined));
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

test('returns preflight errors before creating deps', async () => {
  runStartPreflight.mockResolvedValueOnce(err('CONFIG_ERROR', 'missing verify'));
  const result = await handleStart(false, false);
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'CONFIG_ERROR', message: 'missing verify' }) });
  expect(createDeps).not.toHaveBeenCalled();
  expect(runOrchestrator).not.toHaveBeenCalled();
});

test('dry run skips preflight and orchestration', async () => {
  const result = await handleStart(false, true);
  expect(result.ok).toBe(true);
  expect(runStartPreflight).not.toHaveBeenCalled();
  expect(createDeps).not.toHaveBeenCalled();
});
