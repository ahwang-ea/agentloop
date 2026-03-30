import { access, mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneGcArchives } from '../gc-retention.js';

const repo = () => mkdtemp(join(tmpdir(), 'agentloop-gc-retention-'));
const config = (repoPath: string) => ({ repoPath } as const);
const exists = (path: string) => access(path).then(() => true).catch(() => false);

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
