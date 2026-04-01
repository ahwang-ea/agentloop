import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig } from '../types/index.js';
import { pruneBenchmarkResults } from './benchmark-results.js';

const day = 24 * 60 * 60 * 1000;
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const keep = (timestamp: string, cutoff: number) => Number.isNaN(Date.parse(timestamp)) || Date.parse(timestamp) >= cutoff;

async function pruneArchiveLog(config: Pick<AgentloopConfig, 'repoPath'>, now: number): Promise<Result<void>> {
  const path = join(config.repoPath, '.agentloop', 'archive.jsonl');
  let raw: string;
  try { raw = await readFile(path, 'utf-8'); }
  catch (e) { return missing(e) ? ok(undefined) : err('TRANSPORT_ERROR', `Cannot read ${path}`); }
  const cutoff = now - (180 * day), lines = raw.split('\n').filter(Boolean), kept: string[] = [];
  for (const line of lines) {
    let entry: unknown;
    try { entry = JSON.parse(line); }
    catch { return err('TRANSPORT_ERROR', `Malformed archive log ${path}`); }
    if (typeof (entry as { archivedAt?: unknown }).archivedAt !== 'string' || keep((entry as { archivedAt: string }).archivedAt, cutoff)) kept.push(line);
  }
  if (kept.length === lines.length) return ok(undefined);
  try { await writeFile(path, kept.length === 0 ? '' : `${kept.join('\n')}\n`, 'utf-8'); return ok(undefined); }
  catch { return err('TRANSPORT_ERROR', `Cannot write ${path}`); }
}

async function pruneDir(dir: string, maxAgeMs: number, now: number): Promise<Result<void>> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (e) { return missing(e) ? ok(undefined) : err('TRANSPORT_ERROR', `Cannot read ${dir}`); }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    let info;
    try { info = await stat(path); }
    catch (e) {
      if (missing(e)) continue;
      return err('TRANSPORT_ERROR', `Cannot stat ${path}`);
    }
    if (now - info.mtimeMs <= maxAgeMs) continue;
    try { await rm(path, { force: true }); }
    catch { return err('TRANSPORT_ERROR', `Cannot remove ${path}`); }
  }
  return ok(undefined);
}

export async function pruneGcArchives(config: Pick<AgentloopConfig, 'repoPath'>, now = Date.now()): Promise<Result<void>> {
  const archived = await pruneArchiveLog(config, now); if (!archived.ok) return archived;
  const metrics = await pruneDir(join(config.repoPath, '.agentloop', 'metrics-archive'), 365 * day, now); if (!metrics.ok) return metrics;
  const research = await pruneDir(join(config.repoPath, '.agentloop', 'archive'), 180 * day, now); if (!research.ok) return research;
  return pruneBenchmarkResults(config.repoPath);
}
