import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { err, ok } from '../../shared/result.js';

const execFile = jest.fn(), exec: jest.Mock<(...args: unknown[]) => Promise<{ stdout: string; stderr: string }>> = jest.fn();
(execFile as typeof execFile & { [key: symbol]: unknown })[Symbol.for('nodejs.util.promisify.custom')] = exec;
const runBenchmarkPreflight = jest.fn(async () => ok(undefined));
const runBenchmarkSuite = jest.fn(async () => ok({ suite: 'demo', timestamp: '2026-04-03T00:00:00.000Z', duration: 0, tasksTotal: 1, tasksCompleted: 1, tasksStuck: 0, avgRounds: 1, avgTimeSec: 1, firstPassRate: 100, acceptanceTests: [], score: 1, metricsSnapshot: [] }));
const saveBenchmarkResult = jest.fn(async () => ok(undefined));
const pruneBenchmarkResults = jest.fn(async () => ok(undefined));

await jest.unstable_mockModule('node:child_process', () => ({ execFile }));
await jest.unstable_mockModule('../preflight.js', () => ({ runBenchmarkPreflight }));
await jest.unstable_mockModule('../../benchmarks/index.js', () => ({
  benchmarkCatalog: [{ id: 'demo', fileStem: 'demo', suite: { name: 'Demo', goal: 'goal', maxTimeSec: 60, acceptanceTests: [] } }],
  findBenchmark: (suite: string) => suite === 'demo' ? { id: 'demo', fileStem: 'demo', suite: { name: 'Demo', goal: 'goal', maxTimeSec: 60, acceptanceTests: [] } } : undefined,
}));
await jest.unstable_mockModule('../benchmark-runner.js', () => ({ runBenchmarkSuite }));
await jest.unstable_mockModule('../benchmark-results.js', () => ({ formatBenchmarkTable: () => 'table', saveBenchmarkResult, pruneBenchmarkResults }));
const { appendLedgerEntry } = await import('../benchmark-ledger.js');
const { runBenchmark } = await import('../benchmark.js');
let repoPath = '';

beforeEach(() => {
  runBenchmarkPreflight.mockReset();
  runBenchmarkSuite.mockReset();
  saveBenchmarkResult.mockReset();
  pruneBenchmarkResults.mockReset();
  exec.mockReset();
  runBenchmarkPreflight.mockResolvedValue(ok(undefined));
  runBenchmarkSuite.mockResolvedValue(ok({ suite: 'demo', timestamp: '2026-04-03T00:00:00.000Z', duration: 0, tasksTotal: 1, tasksCompleted: 1, tasksStuck: 0, avgRounds: 1, avgTimeSec: 1, firstPassRate: 100, acceptanceTests: [], score: 1, metricsSnapshot: [] }));
  saveBenchmarkResult.mockResolvedValue(ok(undefined));
  pruneBenchmarkResults.mockResolvedValue(ok(undefined));
  exec.mockResolvedValue({ stdout: 'abc123\n', stderr: '' });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

beforeEach(async () => { repoPath = await mkdtemp(join(tmpdir(), 'agentloop-benchmark-')); });
afterEach(async () => { await rm(repoPath, { recursive: true, force: true }); jest.restoreAllMocks(); });

test('returns preflight errors before running benchmark suites', async () => {
  runBenchmarkPreflight.mockResolvedValueOnce(err('CONFIG_ERROR', 'missing key'));
  const result = await runBenchmark({ repoPath, useCodexWriter: true } as never, { suite: 'demo', list: false });
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'CONFIG_ERROR', message: 'missing key' }) });
  expect(runBenchmarkSuite).not.toHaveBeenCalled();
});

test('lists suites without running preflight', async () => {
  const result = await runBenchmark({ repoPath, useCodexWriter: true } as never, { list: true });
  expect(result.ok).toBe(true);
  expect(runBenchmarkPreflight).not.toHaveBeenCalled();
  expect(runBenchmarkSuite).not.toHaveBeenCalled();
});

test('saves results under the configured repo and prunes retained history', async () => {
  const result = await runBenchmark({ repoPath, useCodexWriter: true } as never, { suite: 'demo', list: false });
  expect(result.ok).toBe(true);
  expect(saveBenchmarkResult).toHaveBeenCalledWith(expect.objectContaining({ fileStem: 'demo' }), expect.objectContaining({ suite: 'demo' }), repoPath);
  expect(pruneBenchmarkResults).toHaveBeenCalledWith(repoPath);
  await expect(readFile(join(repoPath, '.agentloop', 'benchmark-ledger.tsv'), 'utf-8')).resolves.toContain('2026-04-03T00:00:00.000Z\tdemo\t1\t1/1\t0\t0/0\t0\t0\t100\tabc123\t0\t0');
});

test('logs retention failures without failing the benchmark command', async () => {
  pruneBenchmarkResults.mockResolvedValueOnce(err('TRANSPORT_ERROR', `Cannot read ${repoPath}/benchmarks/results`));
  const result = await runBenchmark({ repoPath, useCodexWriter: true } as never, { suite: 'demo', list: false });
  expect(result.ok).toBe(true);
  expect(console.error).toHaveBeenCalledWith(`benchmark retention: Cannot read ${repoPath}/benchmarks/results`);
});

test('writes the header once and appends later benchmark rows', async () => {
  const result = { suite: 'demo', timestamp: '2026-04-03T00:00:00.000Z', duration: 1, tasksTotal: 2, tasksCompleted: 1, tasksStuck: 1, avgRounds: 0, avgTimeSec: 0, firstPassRate: 50, acceptanceTests: [{ name: 'acceptance', passed: true }, { name: 'golden: spec', passed: false }], score: 0.25, metricsSnapshot: [] };
  await expect(appendLedgerEntry(repoPath, result, 'demo')).resolves.toEqual(ok(undefined));
  await expect(appendLedgerEntry(repoPath, { ...result, timestamp: '2026-04-03T00:01:00.000Z' }, 'demo')).resolves.toEqual(ok(undefined));
  await expect(readFile(join(repoPath, '.agentloop', 'benchmark-ledger.tsv'), 'utf-8')).resolves.toBe('timestamp\tsuite\tscore\ttasks\tstuck\tchecks_passed\tchecks_total\tduration_sec\tfirst_pass_rate\tgit_sha\tgolden_passed\tgolden_total\n2026-04-03T00:00:00.000Z\tdemo\t0.25\t1/2\t1\t1/2\t2\t1\t50\tabc123\t0\t1\n2026-04-03T00:01:00.000Z\tdemo\t0.25\t1/2\t1\t1/2\t2\t1\t50\tabc123\t0\t1\n');
});
