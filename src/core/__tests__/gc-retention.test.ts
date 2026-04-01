import { access, mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBenchmarkResults } from '../benchmark-results.js';
import { pruneGcArchives } from '../gc-retention.js';

const repo = () => mkdtemp(join(tmpdir(), 'agentloop-gc-retention-'));
const config = (repoPath: string) => ({ repoPath } as const);
const exists = (path: string) => access(path).then(() => true).catch(() => false);
const result = (suite: string, timestamp: string, version?: number) => ({ ...(version == null ? {} : { version }), suite, timestamp, duration: 1, tasksTotal: 1, tasksCompleted: 1, tasksStuck: 0, avgRounds: 1, avgTimeSec: 1, firstPassRate: 100, acceptanceTests: [{ name: 'compiles', passed: true }], score: 1, metricsSnapshot: [] });

test('prunes archive.jsonl entries older than 180 days', async () => {
  const repoPath = await repo(), path = join(repoPath, '.agentloop', 'archive.jsonl');
  await mkdir(join(repoPath, '.agentloop'), { recursive: true });
  await writeFile(path, `${JSON.stringify({ archivedAt: '2025-01-01T00:00:00.000Z', task: { id: 'old' } })}\n${JSON.stringify({ archivedAt: '2026-03-01T00:00:00.000Z', task: { id: 'new' } })}\n`, 'utf-8');
  const result = await pruneGcArchives(config(repoPath), Date.parse('2026-03-30T00:00:00.000Z'));
  expect(result.ok).toBe(true);
  expect((await readFile(path, 'utf-8')).trim().split('\n')).toHaveLength(1);
  expect(await readFile(path, 'utf-8')).toContain('new');
});

test('prunes stale metrics and research archive files', async () => {
  const repoPath = await repo();
  const metricsDir = join(repoPath, '.agentloop', 'metrics-archive');
  const archiveDir = join(repoPath, '.agentloop', 'archive');
  const oldMetrics = join(metricsDir, 'old.jsonl'), freshMetrics = join(metricsDir, 'fresh.jsonl');
  const oldResearch = join(archiveDir, 'old.md'), freshResearch = join(archiveDir, 'fresh.md');
  await mkdir(metricsDir, { recursive: true });
  await mkdir(archiveDir, { recursive: true });
  await writeFile(oldMetrics, 'old\n', 'utf-8');
  await writeFile(freshMetrics, 'fresh\n', 'utf-8');
  await writeFile(oldResearch, 'old\n', 'utf-8');
  await writeFile(freshResearch, 'fresh\n', 'utf-8');
  await utimes(oldMetrics, new Date('2025-01-01T00:00:00.000Z'), new Date('2025-01-01T00:00:00.000Z'));
  await utimes(oldResearch, new Date('2025-01-01T00:00:00.000Z'), new Date('2025-01-01T00:00:00.000Z'));
  const result = await pruneGcArchives(config(repoPath), Date.parse('2026-03-30T00:00:00.000Z'));
  expect(result.ok).toBe(true);
  expect(await exists(oldMetrics)).toBe(false);
  expect(await exists(oldResearch)).toBe(false);
  expect(await exists(freshMetrics)).toBe(true);
  expect(await exists(freshResearch)).toBe(true);
});

test('prunes benchmark results to the newest 20 files per suite', async () => {
  const repoPath = await repo(), resultsDir = join(repoPath, 'benchmarks', 'results');
  await mkdir(resultsDir, { recursive: true });
  for (let day = 1; day <= 22; day += 1) await writeFile(join(resultsDir, `crm-2026-01-${String(day).padStart(2, '0')}T00-00-00Z.json`), `${JSON.stringify(result('crm', `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`, 2))}\n`, 'utf-8');
  await writeFile(join(resultsDir, 'erp-2026-01-01T00-00-00Z.json'), `${JSON.stringify(result('erp', '2026-01-01T00:00:00.000Z', 2))}\n`, 'utf-8');
  const pruned = await pruneGcArchives(config(repoPath), Date.parse('2026-03-30T00:00:00.000Z'));
  expect(pruned.ok).toBe(true);
  const files = await readdir(resultsDir);
  expect(files).toHaveLength(21);
  expect(files).not.toContain('crm-2026-01-01T00-00-00Z.json');
  expect(files).not.toContain('crm-2026-01-02T00-00-00Z.json');
  expect(files).toContain('crm-2026-01-22T00-00-00Z.json');
  expect(files).toContain('erp-2026-01-01T00-00-00Z.json');
});

test('reads additive future benchmark result versions', async () => {
  const repoPath = await repo(), resultsDir = join(repoPath, 'benchmarks', 'results');
  await mkdir(resultsDir, { recursive: true });
  await writeFile(join(resultsDir, 'legacy.json'), `${JSON.stringify(result('legacy', '2026-03-30T00:00:00.000Z'))}\n`, 'utf-8');
  await writeFile(join(resultsDir, 'future.json'), `${JSON.stringify({ ...result('future', '2026-03-31T00:00:00.000Z', 3), retainedField: 'ignored' })}\n`, 'utf-8');
  const loaded = await readBenchmarkResults(repoPath);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  expect(loaded.value).toHaveLength(2);
  expect(loaded.value.find(item => item.suite === 'legacy')?.version).toBeUndefined();
  expect(loaded.value.find(item => item.suite === 'future')?.version).toBe(2);
});
