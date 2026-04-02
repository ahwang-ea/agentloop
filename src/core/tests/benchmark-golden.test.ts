import { jest } from '@jest/globals';
import { join } from 'node:path';
import { ok } from '../../shared/result.js';
import type { BenchmarkCatalogEntry } from '../../benchmarks/types.js';
import type { AgentloopConfig } from '../../types/index.js';

const repoPath = '/tmp/agentloop-benchmark-runner', goldenPath = join(repoPath, 'src', '__tests__', 'golden.test.ts');
const mkdir = jest.fn(async () => undefined), rm = jest.fn(async () => undefined), writeFile = jest.fn(async () => undefined);
const bootstrapBenchmarkRepo = jest.fn(async () => ok(repoPath)), createDeps = jest.fn(async () => ok({ queue: { list: async () => ok([]) } } as never));
const generatePlan = jest.fn(async () => ok([])), enqueuePlan = jest.fn(async () => ok([])), runOrchestrator = jest.fn(async () => ok(undefined as never));
const runAcceptanceTests = jest.fn(async () => ok([{ name: 'smoke', passed: true }])), readMetricsRecords = jest.fn(async () => ok([] as never));
const runGoldenTests = jest.fn(async () => [] as { name: string; passed: boolean; output?: string }[]);
const verifyAndRetry = jest.fn(async () => ({ retried: false, testsPassed: true }));

await jest.unstable_mockModule('node:fs/promises', () => ({ mkdir, rm, writeFile }));
await jest.unstable_mockModule('../benchmark-bootstrap.js', () => ({ bootstrapBenchmarkRepo }));
await jest.unstable_mockModule('../deps.js', () => ({ createDeps }));
await jest.unstable_mockModule('../planner.js', () => ({ generatePlan, enqueuePlan, flattenPlan: jest.fn((plan: unknown[]) => plan), formatPlan: jest.fn() }));
await jest.unstable_mockModule('../../orchestrator.js', () => ({ runOrchestrator }));
await jest.unstable_mockModule('../benchmark-acceptance.js', () => ({ runAcceptanceTests }));
await jest.unstable_mockModule('../benchmark-golden-runner.js', () => ({ runGoldenTests }));
await jest.unstable_mockModule('../benchmark-verify-loop.js', () => ({ verifyAndRetry }));
await jest.unstable_mockModule('../metrics-report.js', () => ({ readMetricsRecords }));
const { runBenchmarkSuite } = await import('../benchmark-runner.js');

const acceptance = (golden = false) => golden
  ? [{ type: 'command' as const, name: 'golden tests pass', cmd: 'npm', args: ['test', '--', '--testPathPatterns', 'golden'] }]
  : [{ type: 'command' as const, name: 'smoke', cmd: 'npm', args: ['test'] }];
const entry = (goldenTestFile?: string): BenchmarkCatalogEntry => ({
  id: 'crm', fileStem: 'crm', suite: { name: 'CRM', goal: 'build a crm', maxTimeSec: 60, acceptanceTests: acceptance(Boolean(goldenTestFile)), ...(goldenTestFile ? { goldenTestFile } : {}) },
});
const config: AgentloopConfig = {
  repoPath: '.', baseBranch: 'main', branchPrefix: 'al/', worktreeRoot: '.worktrees', verifyCommand: './verify.sh', agentsMdPath: 'AGENTS.md', architectureMdPath: 'ARCHITECTURE.md', claudeModel: 'claude', codexModel: 'codex', codexEnabled: true, useCodexWriter: true, autoApproveResearch: false,
  convergence: { maxWallClock: 1, maxTokens: 1, stuckThreshold: 1, thrashOverlapRatio: 0.5 }, taskSource: 'file', taskFilePath: 'tasks.json', maxParallelAgents: 2, maxTasksPerSession: 3, maxTokensPerSession: 100000, parallelVerify: true, sweepInterval: 1,
};

beforeEach(() => {
  jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  process.env.AGENTLOOP_BENCHMARK_ATTEMPTS = '1';
  for (const mock of [mkdir, rm, writeFile, bootstrapBenchmarkRepo, createDeps, generatePlan, enqueuePlan, runOrchestrator, runAcceptanceTests, runGoldenTests, verifyAndRetry, readMetricsRecords]) mock.mockReset();
  bootstrapBenchmarkRepo.mockResolvedValue(ok(repoPath));
  createDeps.mockResolvedValue(ok({ queue: { list: async () => ok([]) } } as never));
  generatePlan.mockResolvedValue(ok([])); enqueuePlan.mockResolvedValue(ok([])); runOrchestrator.mockResolvedValue(ok(undefined as never));
  runGoldenTests.mockResolvedValue([]);
  verifyAndRetry.mockResolvedValue({ retried: false, testsPassed: true });
  runAcceptanceTests.mockResolvedValue(ok([{ name: 'smoke', passed: true }])); readMetricsRecords.mockResolvedValue(ok([] as never));
  mkdir.mockResolvedValue(undefined); rm.mockResolvedValue(undefined); writeFile.mockResolvedValue(undefined);
});

afterEach(() => { delete process.env.AGENTLOOP_BENCHMARK_ATTEMPTS; jest.restoreAllMocks(); });

test('writes the injected golden test file when configured', async () => {
  await runBenchmarkSuite(entry('test("golden", () => expect(true).toBe(true));\n'), config);
  expect(writeFile).toHaveBeenCalledWith(goldenPath, 'test("golden", () => expect(true).toBe(true));\n', 'utf-8');
});

test('does not write a golden test file when none is configured', async () => {
  await runBenchmarkSuite(entry(), config);
  expect(writeFile).not.toHaveBeenCalledWith(goldenPath, expect.any(String), 'utf-8');
});

test('writes the golden test after orchestration and before acceptance', async () => {
  await runBenchmarkSuite(entry('test("golden", () => expect(true).toBe(true));\n'), config);
  expect(runOrchestrator.mock.invocationCallOrder[0]).toBeLessThan(writeFile.mock.invocationCallOrder[0]);
  expect(writeFile.mock.invocationCallOrder[0]).toBeLessThan(runAcceptanceTests.mock.invocationCallOrder[0]);
});

test('continues with a failed acceptance result if golden injection fails', async () => {
  writeFile.mockRejectedValueOnce(new Error('disk full'));
  runGoldenTests.mockResolvedValueOnce([{ name: 'golden', passed: false, output: 'missing golden test' }]);
  runAcceptanceTests.mockResolvedValueOnce(ok([{ name: 'golden tests pass', passed: false, output: 'missing golden test' }]));
  const result = await runBenchmarkSuite(entry('test("golden", () => expect(true).toBe(true));\n'), config);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(runGoldenTests).toHaveBeenCalledWith(repoPath);
  expect(runAcceptanceTests).toHaveBeenCalledWith(repoPath, acceptance(true));
  expect(result.value.acceptanceTests).toEqual([
    { name: 'golden tests pass', passed: false, output: 'missing golden test' },
    { name: 'golden', passed: false, output: 'missing golden test' },
  ]);
});
