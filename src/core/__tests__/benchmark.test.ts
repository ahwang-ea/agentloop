import { jest } from '@jest/globals';
import { err, ok } from '../../shared/result.js';

const runBenchmarkPreflight = jest.fn(async () => ok(undefined));
const runBenchmarkSuite = jest.fn(async () => ok({ suite: 'demo', timestamp: '', duration: 0, tasksTotal: 1, tasksCompleted: 1, tasksStuck: 0, avgRounds: 1, avgTimeSec: 1, firstPassRate: 100, acceptanceTests: [], score: 1, metricsSnapshot: [] }));
const saveBenchmarkResult = jest.fn(async () => ok(undefined));
const pruneBenchmarkResults = jest.fn(async () => ok(undefined));

await jest.unstable_mockModule('../preflight.js', () => ({ runBenchmarkPreflight }));
await jest.unstable_mockModule('../../benchmarks/index.js', () => ({
  benchmarkCatalog: [{ id: 'demo', fileStem: 'demo', suite: { name: 'Demo', goal: 'goal', maxTimeSec: 60, acceptanceTests: [] } }],
  findBenchmark: (suite: string) => suite === 'demo' ? { id: 'demo', fileStem: 'demo', suite: { name: 'Demo', goal: 'goal', maxTimeSec: 60, acceptanceTests: [] } } : undefined,
}));
await jest.unstable_mockModule('../benchmark-runner.js', () => ({ runBenchmarkSuite }));
await jest.unstable_mockModule('../benchmark-results.js', () => ({ formatBenchmarkTable: () => 'table', saveBenchmarkResult, pruneBenchmarkResults }));
const { runBenchmark } = await import('../benchmark.js');

beforeEach(() => {
  runBenchmarkPreflight.mockReset();
  runBenchmarkSuite.mockReset();
  saveBenchmarkResult.mockReset();
  pruneBenchmarkResults.mockReset();
  runBenchmarkPreflight.mockResolvedValue(ok(undefined));
  runBenchmarkSuite.mockResolvedValue(ok({ suite: 'demo', timestamp: '', duration: 0, tasksTotal: 1, tasksCompleted: 1, tasksStuck: 0, avgRounds: 1, avgTimeSec: 1, firstPassRate: 100, acceptanceTests: [], score: 1, metricsSnapshot: [] }));
  saveBenchmarkResult.mockResolvedValue(ok(undefined));
  pruneBenchmarkResults.mockResolvedValue(ok(undefined));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

test('returns preflight errors before running benchmark suites', async () => {
  runBenchmarkPreflight.mockResolvedValueOnce(err('CONFIG_ERROR', 'missing key'));
  const result = await runBenchmark({ repoPath: '/repo', useCodexWriter: true } as never, { suite: 'demo', list: false });
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'CONFIG_ERROR', message: 'missing key' }) });
  expect(runBenchmarkSuite).not.toHaveBeenCalled();
});

test('lists suites without running preflight', async () => {
  const result = await runBenchmark({ repoPath: '/repo', useCodexWriter: true } as never, { list: true });
  expect(result.ok).toBe(true);
  expect(runBenchmarkPreflight).not.toHaveBeenCalled();
  expect(runBenchmarkSuite).not.toHaveBeenCalled();
});

test('saves results under the configured repo and prunes retained history', async () => {
  const result = await runBenchmark({ repoPath: '/repo', useCodexWriter: true } as never, { suite: 'demo', list: false });
  expect(result.ok).toBe(true);
  expect(saveBenchmarkResult).toHaveBeenCalledWith(expect.objectContaining({ fileStem: 'demo' }), expect.objectContaining({ suite: 'demo' }), '/repo');
  expect(pruneBenchmarkResults).toHaveBeenCalledWith('/repo');
});

test('logs retention failures without failing the benchmark command', async () => {
  pruneBenchmarkResults.mockResolvedValueOnce(err('TRANSPORT_ERROR', 'Cannot read /repo/benchmarks/results'));
  const result = await runBenchmark({ repoPath: '/repo', useCodexWriter: true } as never, { suite: 'demo', list: false });
  expect(result.ok).toBe(true);
  expect(console.error).toHaveBeenCalledWith('benchmark retention: Cannot read /repo/benchmarks/results');
});
