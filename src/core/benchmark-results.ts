import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from '../shared/result.js';
import type { BenchmarkCatalogEntry, BenchmarkResult } from '../benchmarks/types.js';

const round = (value: number) => Math.round(value * 100) / 100;
const stamp = (value: string) => value.replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
const dir = () => join(process.cwd(), 'benchmarks', 'results');
const minutes = (seconds: number) => `${Math.max(1, Math.round(seconds / 60))}m`;
const pad = (value: string, width: number) => value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`;

export async function saveBenchmarkResult(entry: BenchmarkCatalogEntry, result: BenchmarkResult): Promise<Result<string>> {
  const path = join(dir(), `${entry.fileStem}-${stamp(result.timestamp)}.json`);
  try { await mkdir(dir(), { recursive: true }); await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, 'utf-8'); return ok(path); }
  catch { return err('TRANSPORT_ERROR', `Cannot write benchmark result ${path}`); }
}

export async function readBenchmarkResult(path: string): Promise<Result<BenchmarkResult>> {
  try { return ok(JSON.parse(await readFile(path, 'utf-8')) as BenchmarkResult); }
  catch { return err('TRANSPORT_ERROR', `Cannot read benchmark result ${path}`); }
}

export async function readBenchmarkResults(): Promise<Result<BenchmarkResult[]>> {
  try {
    const files = (await readdir(dir())).filter(file => file.endsWith('.json')).sort();
    const loaded = await Promise.all(files.map(file => readBenchmarkResult(join(dir(), file))));
    const failed = loaded.find(result => !result.ok); if (failed && !failed.ok) return failed;
    return ok(loaded.filter((result): result is { ok: true; value: BenchmarkResult } => result.ok).map(result => result.value).sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
  } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? ok([]) : err('TRANSPORT_ERROR', `Cannot read ${dir()}`); }
}

export const latestBenchmarkResults = (results: BenchmarkResult[]) => [...results.reduce((map, result) => map.set(result.suite, result), new Map<string, BenchmarkResult>()).values()];
export const benchmarkHistory = (results: BenchmarkResult[], size = 3) => [...results.reduce((map, result) => map.set(result.suite, [...(map.get(result.suite) ?? []), result].slice(-size)), new Map<string, BenchmarkResult[]>()).entries()];

export const benchmarkTrend = (values: number[], kind: 'ratio' | 'percent' | 'number') => values.length < 3 ? undefined : `${values.map(value => kind === 'percent' ? `${Math.round(value)}%` : round(value).toFixed(2).replace(/\.00$/, '')).join(' → ')} (${values[0] === values[2] ? 'flat' : values[0] < values[2] ? 'improving' : 'degrading'})`;

export const formatBenchmarkTable = (entries: Array<{ entry: BenchmarkCatalogEntry; result: BenchmarkResult }>) => [
  `Benchmark results — ${new Date().toISOString()}`,
  '┌──────────────────┬───────┬────────┬───────┬────────┬─────────┐',
  '│ Suite            │ Score │ Tasks  │ Stuck │ Rounds │ Time    │',
  '├──────────────────┼───────┼────────┼───────┼────────┼─────────┤',
  ...entries.map(({ entry, result }) => `│ ${pad(entry.fileStem, 16)} │ ${pad(result.score.toFixed(2), 5)} │ ${pad(`${result.tasksCompleted}/${result.tasksTotal}`, 6)} │ ${pad(String(result.tasksStuck), 5)} │ ${pad(result.avgRounds.toFixed(1), 6)} │ ${pad(minutes(result.duration), 7)} │`),
  '└──────────────────┴───────┴────────┴───────┴────────┴─────────┘',
].join('\n');
