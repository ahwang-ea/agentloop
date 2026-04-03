import { err, ok, type Result } from '../shared/result.js';
import type { BenchmarkCatalogEntry, BenchmarkResult } from '../benchmarks/types.js';
import type { AgentloopConfig } from '../types/index.js';
import { benchmarkCatalog, findBenchmark } from '../benchmarks/index.js';
import { appendLedgerEntry } from './benchmark-ledger.js';
import { formatBenchmarkTable, pruneBenchmarkResults, saveBenchmarkResult } from './benchmark-results.js';
import { runBenchmarkSuite } from './benchmark-runner.js';
import { runBenchmarkPreflight } from './preflight.js';

interface BenchmarkOptions { list: boolean; suite?: string; }

export async function runBenchmark(config: AgentloopConfig, options: BenchmarkOptions): Promise<Result<void>> {
  if (options.list) {
    console.log(benchmarkCatalog.map(entry => `${entry.id} — ${entry.suite.name}`).join('\n'));
    return ok(undefined);
  }
  const preflight = await runBenchmarkPreflight(config); if (!preflight.ok) return preflight;
  const match = options.suite ? findBenchmark(options.suite) : undefined;
  const entries = options.suite === 'all' ? benchmarkCatalog : match ? [match] : [];
  if (entries.length === 0) return err('CONFIG_ERROR', `Unknown benchmark suite: ${options.suite ?? '(missing)'}`);
  const results: Array<{ entry: BenchmarkCatalogEntry; result: BenchmarkResult }> = [];
  for (const entry of entries) {
    const result = await runBenchmarkSuite(entry, config); if (!result.ok) return result;
    const saved = await saveBenchmarkResult(entry, result.value, config.repoPath); if (!saved.ok) return saved;
    const ledger = await appendLedgerEntry(config.repoPath, result.value, entry.fileStem); if (!ledger.ok) return ledger;
    results.push({ entry, result: result.value });
  }
  const pruned = await pruneBenchmarkResults(config.repoPath); if (!pruned.ok) console.error(`benchmark retention: ${pruned.error.message}`);
  console.log(formatBenchmarkTable(results));
  return ok(undefined);
}
