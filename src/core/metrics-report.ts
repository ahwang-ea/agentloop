import { readFile } from 'node:fs/promises';
import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, MetricsRecord } from '../types/index.js';
import { metricsPath } from './metrics.js';

interface MetricsPeriod {
  tasks: number;
  avgRounds: number;
  avgTimeSec: number;
  firstPassRate: number;
  stuckRate: number;
  topError: string | null;
  topErrorCount: number;
}
export interface MetricsSummary {
  last7: MetricsPeriod;
  previous7: MetricsPeriod;
  trend: 'improving' | 'degrading' | 'flat' | 'insufficient-data';
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const pct = (count: number, total: number) => total === 0 ? 0 : Math.round((count / total) * 100);
const formatDuration = (seconds: number) => seconds >= 60 ? `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s` : `${Math.round(seconds)}s`;
const time = (timestamp: string) => Date.parse(timestamp);
const isNewer = (next: MetricsRecord, current?: MetricsRecord) => !current || Number.isNaN(time(current.timestamp)) || (!Number.isNaN(time(next.timestamp)) && time(next.timestamp) >= time(current.timestamp));

export function parseMetrics(raw: string, path: string): Result<MetricsRecord[]> {
  const latest = new Map<string, MetricsRecord>();
  for (const line of raw.split('\n').filter(Boolean)) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return err('TRANSPORT_ERROR', `Malformed metrics log ${path}`); }
    const record = value as Partial<MetricsRecord> & { time_sec?: number; review_findings?: number };
    if (typeof record.task_id !== 'string' || typeof record.task !== 'string' || typeof record.timestamp !== 'string') return err('TRANSPORT_ERROR', `Malformed metrics log ${path}`);
    const next: MetricsRecord = {
      task_id: record.task_id, task: record.task, rounds: typeof record.rounds === 'number' ? record.rounds : 0,
      timeSec: typeof record.time_sec === 'number' ? record.time_sec : 0, reviewFindings: typeof record.review_findings === 'number' ? record.review_findings : 0,
      outcome: record.outcome ?? 'blocked', errors: Array.isArray(record.errors) ? record.errors.filter((item): item is string => typeof item === 'string') : [],
      files: Array.isArray(record.files) ? record.files.filter((item): item is string => typeof item === 'string') : [], timestamp: record.timestamp,
    };
    if (isNewer(next, latest.get(next.task_id))) latest.set(next.task_id, next);
  }
  return ok([...latest.values()]);
}
export async function readMetricsRecords(config: Pick<AgentloopConfig, 'repoPath'>): Promise<Result<MetricsRecord[]>> {
  const path = metricsPath(config);
  try { return parseMetrics(await readFile(path, 'utf-8'), path); }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? ok([]) : err('TRANSPORT_ERROR', `Cannot read metrics ${path}`); }
}

function summarize(records: MetricsRecord[], from: number, to: number): MetricsPeriod {
  const windowed = records.filter(record => { const timestamp = time(record.timestamp); return !Number.isNaN(timestamp) && timestamp >= from && timestamp < to; });
  const errorCounts = new Map<string, number>();
  for (const record of windowed) for (const error of record.errors) errorCounts.set(error, (errorCounts.get(error) ?? 0) + 1);
  const [topError, topErrorCount] = [...errorCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [null, 0];
  const totalRounds = windowed.reduce((sum, record) => sum + record.rounds, 0), totalTime = windowed.reduce((sum, record) => sum + record.timeSec, 0);
  return { tasks: windowed.length, avgRounds: windowed.length === 0 ? 0 : round1(totalRounds / windowed.length), avgTimeSec: windowed.length === 0 ? 0 : round1(totalTime / windowed.length), firstPassRate: pct(windowed.filter(record => record.rounds === 1).length, windowed.length), stuckRate: pct(windowed.filter(record => record.outcome === 'stuck').length, windowed.length), topError, topErrorCount };
}
function trend(last7: MetricsPeriod, previous7: MetricsPeriod): MetricsSummary['trend'] {
  if (last7.tasks === 0 || previous7.tasks === 0) return 'insufficient-data';
  const score = [Math.sign(previous7.avgRounds - last7.avgRounds), Math.sign(previous7.avgTimeSec - last7.avgTimeSec), Math.sign(last7.firstPassRate - previous7.firstPassRate), Math.sign(previous7.stuckRate - last7.stuckRate)].reduce((sum, value) => sum + value, 0);
  return score >= 2 ? 'improving' : score <= -2 ? 'degrading' : 'flat';
}
export async function readMetricsSummary(config: Pick<AgentloopConfig, 'repoPath'>): Promise<Result<MetricsSummary>> {
  const metrics = await readMetricsRecords(config); if (!metrics.ok) return metrics;
  const now = Date.now(), day = 86_400_000, last7 = summarize(metrics.value, now - (7 * day), now + 1), previous7 = summarize(metrics.value, now - (14 * day), now - (7 * day));
  return ok({ last7, previous7, trend: trend(last7, previous7) });
}
export const formatMetricsSummary = (summary: MetricsSummary) => summary.last7.tasks === 0 && summary.previous7.tasks === 0 ? 'No task metrics recorded yet.' : [
  `Last 7 days: ${summary.last7.tasks} tasks`, `Average rounds per task: ${summary.last7.avgRounds}`, `Average time per task: ${formatDuration(summary.last7.avgTimeSec)}`,
  `First-pass clean rate: ${summary.last7.firstPassRate}%`, `Stuck rate: ${summary.last7.stuckRate}%`, `Most common error type: ${summary.last7.topError ? `${summary.last7.topError} (${summary.last7.topErrorCount})` : 'none'}`,
  `Trend vs previous 7 days: ${summary.trend}`,
].join('\n');
