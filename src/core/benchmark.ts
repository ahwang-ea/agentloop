import { err, ok, type Result } from '../shared/result.js';
import type { BenchmarkCatalogEntry, BenchmarkResult } from '../benchmarks/types.js';
import type { AgentloopConfig } from '../types/index.js';
import { benchmarkCatalog, findBenchmark } from '../benchmarks/index.js';
import { formatBenchmarkTable, saveBenchmarkResult } from './benchmark-results.js';
import { runBenchmarkSuite } from './benchmark-runner.js';

interface BenchmarkOptions { list: boolean; suite?: string; }

export async function runBenchmark(config: AgentloopConfig, options: BenchmarkOptions): Promise<Result<void>> {
  if (options.list) {
    console.log(benchmarkCatalog.map(entry => `${entry.id} — ${entry.suite.name}`).join('\n'));
    return ok(undefined);
  }
  if (!process.env.ANTHROPIC_API_KEY || !process.env.OPENAI_API_KEY) return err('CONFIG_ERROR', 'benchmark requires ANTHROPIC_API_KEY and OPENAI_API_KEY');
  const match = options.suite ? findBenchmark(options.suite) : undefined;
  const entries = options.suite === 'all' ? benchmarkCatalog : match ? [match] : [];
  if (entries.length === 0) return err('CONFIG_ERROR', `Unknown benchmark suite: ${options.suite ?? '(missing)'}`);
  const results: Array<{ entry: BenchmarkCatalogEntry; result: BenchmarkResult }> = [];
  for (const entry of entries) {
    const result = await runBenchmarkSuite(entry, config); if (!result.ok) return result;
    const saved = await saveBenchmarkResult(entry, result.value); if (!saved.ok) return saved;
    results.push({ entry, result: result.value });
  }
  console.log(formatBenchmarkTable(results));
  return ok(undefined);
}
