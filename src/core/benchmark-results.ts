import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { err, ok, type Result } from '../shared/result.js';
import type { BenchmarkCatalogEntry, BenchmarkResult } from '../benchmarks/types.js';

const round = (value: number) => Math.round(value * 100) / 100;
const stamp = (value: string) => value.replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
export const benchmarkResultsRetention = { maxPerSuite: 20 } as const;
const dir = (root = process.cwd()) => join(root, 'benchmarks', 'results');
const pathFor = (path: string, root = process.cwd()) => isAbsolute(path) ? path : join(root, path);
const minutes = (seconds: number) => `${Math.max(1, Math.round(seconds / 60))}m`;
const pad = (value: string, width: number) => value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`;
const object = (value: unknown) => typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const tests = (value: unknown) => {
  const items = Array.isArray(value) ? value.map(item => {
    const test = object(item), name = text(test?.name), passed = typeof test?.passed === 'boolean' ? test.passed : undefined;
    return test && name && passed !== undefined && (test.output == null || typeof test.output === 'string') ? { name, passed, ...(typeof test.output === 'string' ? { output: test.output } : {}) } : undefined;
  }) : undefined;
  return items?.every((item): item is NonNullable<typeof item> => item != null) ? items : undefined;
};
const metrics = (value: unknown) => Array.isArray(value) && value.every(item => object(item)) ? value as BenchmarkResult['metricsSnapshot'] : undefined;
const firstPass = (value: unknown) => {
  const item = object(value), definition = text(item?.definition), successes = number(item?.successes), consideredTasks = number(item?.consideredTasks);
  return item && definition && successes !== undefined && consideredTasks !== undefined ? { definition, successes, consideredTasks } : undefined;
};
const metadata = (value: unknown) => {
  const item = object(value), models = object(item?.models), runtime = object(item?.runtime);
  const claude = text(models?.claude), codex = text(models?.codex), node = text(runtime?.node), platform = text(runtime?.platform), arch = text(runtime?.arch);
  return item?.mode === 'benchmark-fast-path' && typeof item.depcheckSkipped === 'boolean' && typeof item.reviewEnabled === 'boolean' && typeof item.sweepEnabled === 'boolean' && typeof item.useCodexWriter === 'boolean' && claude && codex && node && platform && arch
    ? { mode: 'benchmark-fast-path' as const, depcheckSkipped: item.depcheckSkipped, reviewEnabled: item.reviewEnabled, sweepEnabled: item.sweepEnabled, useCodexWriter: item.useCodexWriter, models: { claude, codex }, runtime: { node, platform, arch } }
    : undefined;
};

function parseBenchmarkResult(raw: string, path: string): Result<BenchmarkResult> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return err('TRANSPORT_ERROR', `Malformed benchmark result ${path}`); }
  const value = object(parsed), version = value?.version == null ? undefined : typeof value.version === 'number' && Number.isInteger(value.version) && value.version >= 2 ? 2 : null;
  const suite = text(value?.suite), timestamp = text(value?.timestamp), duration = number(value?.duration), tasksTotal = number(value?.tasksTotal), tasksCompleted = number(value?.tasksCompleted), tasksStuck = number(value?.tasksStuck), avgRounds = number(value?.avgRounds), avgTimeSec = number(value?.avgTimeSec), firstPassRate = number(value?.firstPassRate), acceptanceTests = tests(value?.acceptanceTests), score = number(value?.score), metricsSnapshot = metrics(value?.metricsSnapshot);
  if (!value || version === null || !suite || !timestamp || duration === undefined || tasksTotal === undefined || tasksCompleted === undefined || tasksStuck === undefined || avgRounds === undefined || avgTimeSec === undefined || firstPassRate === undefined || !acceptanceTests || score === undefined || !metricsSnapshot) return err('TRANSPORT_ERROR', `Malformed benchmark result ${path}`);
  const parsedFirstPass = value.firstPass == null ? undefined : firstPass(value.firstPass), runMetadata = value.runMetadata == null ? undefined : metadata(value.runMetadata);
  if ((value.firstPass != null && !parsedFirstPass) || (value.runMetadata != null && !runMetadata)) return err('TRANSPORT_ERROR', `Malformed benchmark result ${path}`);
  return ok({ version, suite, timestamp, duration, tasksTotal, tasksCompleted, tasksStuck, avgRounds, avgTimeSec, firstPassRate, ...(parsedFirstPass ? { firstPass: parsedFirstPass } : {}), acceptanceTests, score, metricsSnapshot, ...(runMetadata ? { runMetadata } : {}) });
}

export async function saveBenchmarkResult(entry: BenchmarkCatalogEntry, result: BenchmarkResult, root = process.cwd()): Promise<Result<string>> {
  const path = join(dir(root), `${entry.fileStem}-${stamp(result.timestamp)}.json`);
  try { await mkdir(dir(root), { recursive: true }); await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, 'utf-8'); return ok(path); }
  catch { return err('TRANSPORT_ERROR', `Cannot write benchmark result ${path}`); }
}

export async function readBenchmarkResult(path: string, root = process.cwd()): Promise<Result<BenchmarkResult>> {
  const target = pathFor(path, root);
  try { return parseBenchmarkResult(await readFile(target, 'utf-8'), target); }
  catch { return err('TRANSPORT_ERROR', `Cannot read benchmark result ${target}`); }
}

export async function readBenchmarkResults(root = process.cwd()): Promise<Result<BenchmarkResult[]>> {
  try {
    const files = (await readdir(dir(root))).filter(file => file.endsWith('.json')).sort();
    const loaded = await Promise.all(files.map(file => readBenchmarkResult(join(dir(root), file), root)));
    const failed = loaded.find(result => !result.ok); if (failed && !failed.ok) return failed;
    return ok(loaded.filter((result): result is { ok: true; value: BenchmarkResult } => result.ok).map(result => result.value).sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
  } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? ok([]) : err('TRANSPORT_ERROR', `Cannot read ${dir(root)}`); }
}

export async function pruneBenchmarkResults(root = process.cwd()): Promise<Result<void>> {
  try {
    const base = dir(root), files = (await readdir(base)).filter(file => file.endsWith('.json')).sort();
    const loaded = await Promise.all(files.map(async file => {
      const path = join(base, file), result = await readBenchmarkResult(path, root);
      return result.ok ? ok({ path, result: result.value }) : result;
    }));
    const failed = loaded.find(result => !result.ok); if (failed && !failed.ok) return failed;
    const grouped = loaded.filter((result): result is { ok: true; value: { path: string; result: BenchmarkResult } } => result.ok)
      .reduce((map, result) => map.set(result.value.result.suite, [...(map.get(result.value.result.suite) ?? []), result.value]), new Map<string, Array<{ path: string; result: BenchmarkResult }>>());
    for (const results of grouped.values()) for (const stale of results.sort((a, b) => b.result.timestamp.localeCompare(a.result.timestamp) || b.path.localeCompare(a.path)).slice(benchmarkResultsRetention.maxPerSuite)) {
      try { await rm(stale.path, { force: true }); }
      catch { return err('TRANSPORT_ERROR', `Cannot remove ${stale.path}`); }
    }
    return ok(undefined);
  } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? ok(undefined) : err('TRANSPORT_ERROR', `Cannot read ${dir(root)}`); }
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
