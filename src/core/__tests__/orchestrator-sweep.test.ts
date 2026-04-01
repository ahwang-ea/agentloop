import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { err, ok } from '../../shared/result.js';

const architectSweep = jest.fn(async () => ok(undefined));
const roots: string[] = [];
const repo = async () => { const root = await mkdtemp(join(tmpdir(), 'agentloop-orchestrator-sweep-')); roots.push(root); return root; };
const config = (repoPath: string, overrides: Partial<{ maxParallelAgents: number; sweepInterval: number }> = {}) => ({
  repoPath,
  baseBranch: 'main',
  branchPrefix: 'al/',
  worktreeRoot: '.worktrees',
  verifyCommand: './verify.sh',
  agentsMdPath: join(repoPath, 'AGENTS.md'),
  architectureMdPath: join(repoPath, 'ARCHITECTURE.md'),
  claudeModel: 'claude',
  codexModel: 'codex',
  codexEnabled: true,
  convergence: { maxWallClock: 1, maxTokens: 1, stuckThreshold: 1, thrashOverlapRatio: 0.5 },
  taskSource: 'file' as const,
  taskFilePath: join(repoPath, 'tasks.json'),
  maxParallelAgents: overrides.maxParallelAgents ?? 1,
  maxTasksPerSession: 3,
  maxTokensPerSession: 100000,
  parallelVerify: true,
  sweepInterval: overrides.sweepInterval ?? 1,
});
const deps = (repoPath: string, overrides: Partial<{ maxParallelAgents: number; sweepInterval: number }> = {}) => ({
  config: config(repoPath, overrides),
  queue: { claimNextActionable: async () => ok(null), list: async () => ok([]) },
  notifier: { send: async () => ok(undefined) },
} as never);

await jest.unstable_mockModule('../sweep.js', () => ({ architectSweep }));
const { runOrchestrator } = await import('../../orchestrator.js');

beforeEach(() => architectSweep.mockImplementation(async () => ok(undefined)));
afterEach(async () => {
  jest.restoreAllMocks();
  architectSweep.mockReset();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test('stops cleanly without architect sweep when disabled', async () => {
  const result = await runOrchestrator(deps(await repo(), { sweepInterval: 0 }));
  expect(result.ok).toBe(true);
  expect(architectSweep).not.toHaveBeenCalled();
});

test('runs architect sweep only once across in-process workers', async () => {
  const result = await runOrchestrator(deps(await repo(), { maxParallelAgents: 2 }));
  expect(result.ok).toBe(true);
  expect(architectSweep).toHaveBeenCalledTimes(1);
});

test('skips architect sweep when another process holds the repo lock', async () => {
  const repoPath = await repo();
  await mkdir(join(repoPath, '.agentloop', 'architect-sweep.lock'), { recursive: true });
  const result = await runOrchestrator(deps(repoPath));
  expect(result.ok).toBe(true);
  expect(architectSweep).not.toHaveBeenCalled();
});

test('logs sweep failures and continues', async () => {
  architectSweep.mockImplementationOnce(async () => err('TRANSPORT_ERROR', 'sweep failed'));
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const result = await runOrchestrator(deps(await repo()));
  expect(result.ok).toBe(true);
  expect(architectSweep).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledWith('sweep failed');
});
