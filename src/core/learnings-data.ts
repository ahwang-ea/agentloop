import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, LearningEntry, MetricsRecord, TaskDefinition } from '../types/index.js';
import { metricsPath } from './metrics.js';
import { asNumber, asObjectArray, asString, parseJson, unwrapVersioned } from './persisted-json.js';

const moduleOf = (path: string) => {
  const parts = path.split('/').filter(Boolean), src = parts.lastIndexOf('src');
  const raw = src >= 0 && parts[src + 1] ? parts[src + 1] : parts[0] ?? 'general';
  return raw.replace(/\.[^.]+$/, '').replace(/\.test$/, '') || 'general';
};
const labelOf = (pattern: string) => pattern.replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || 'unknown issue';
const byValue = (a: LearningEntry, b: LearningEntry) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen) || a.pattern.localeCompare(b.pattern);
const addendum = (items: LearningEntry[]) => items.length === 0 ? '' : ['Common mistakes in this area:', ...items.map(item => `- ${item.pattern} (seen ${item.count} times)`)].join('\n');
type ParsedMetricsRecord = Partial<MetricsRecord> & {
  time_sec?: number; review_findings?: number; task_type?: MetricsRecord['taskType']; token_total?: number; verify_time_sec?: number;
};

export const pathOf = (c: Pick<AgentloopConfig, 'repoPath'>, file: string) => join(c.repoPath, '.agentloop', file);
export const agentsPath = (c: Pick<AgentloopConfig, 'repoPath' | 'agentsMdPath'>) => isAbsolute(c.agentsMdPath) ? c.agentsMdPath : join(c.repoPath, c.agentsMdPath);

export async function readLearnings(path: string): Promise<Result<LearningEntry[]>> {
  try {
    const parsed = parseJson(await readFile(path, 'utf-8'), path); if (!parsed.ok) return parsed;
    const items = asObjectArray(unwrapVersioned(parsed.value, 'entries')); if (!items) return err('TRANSPORT_ERROR', `Malformed ${path}: invalid learnings`);
    const learnings: LearningEntry[] = [];
    for (const item of items) {
      const pattern = asString(item.pattern), module = asString(item.module), count = asNumber(item.count), lastSeen = asString(item.lastSeen), suggestion = asString(item.suggestion);
      if (!pattern || !module || count == null || !lastSeen || !suggestion) return err('TRANSPORT_ERROR', `Malformed ${path}: invalid learning entry`);
      learnings.push({ pattern, module, count, lastSeen, suggestion });
    }
    return ok(learnings);
  } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? ok([]) : err('TRANSPORT_ERROR', `Cannot read ${path}`); }
}

export async function readText(path: string, fallback = ''): Promise<Result<string>> {
  try { return ok(await readFile(path, 'utf-8')); }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? ok(fallback) : err('TRANSPORT_ERROR', `Cannot read ${path}`); }
}

export async function recentMetrics(config: Pick<AgentloopConfig, 'repoPath'>): Promise<Result<{ total: number; entries: MetricsRecord[] }>> {
  try {
    const path = metricsPath(config), lines = (await readFile(path, 'utf-8')).trim().split('\n').filter(Boolean), entries: MetricsRecord[] = [];
    for (const line of lines.slice(-20)) {
      const parsed = parseJson(line, path); if (!parsed.ok) return err('TRANSPORT_ERROR', 'Cannot read metrics.jsonl');
      const item = parsed.value as ParsedMetricsRecord;
      if (typeof item.task_id !== 'string' || typeof item.task !== 'string' || typeof item.timestamp !== 'string') return err('TRANSPORT_ERROR', 'Cannot read metrics.jsonl');
      entries.push({ version: item.version === 2 ? 2 : undefined, task_id: item.task_id, task: item.task, rounds: typeof item.rounds === 'number' ? item.rounds : 0, timeSec: typeof item.time_sec === 'number' ? item.time_sec : 0, reviewFindings: typeof item.review_findings === 'number' ? item.review_findings : 0, outcome: item.outcome ?? 'blocked', errors: Array.isArray(item.errors) ? item.errors.filter((value): value is string => typeof value === 'string') : [], files: Array.isArray(item.files) ? item.files.filter((value): value is string => typeof value === 'string') : [], timestamp: item.timestamp, taskType: item.task_type ?? item.taskType, tokenTotal: typeof item.token_total === 'number' ? item.token_total : typeof item.tokenTotal === 'number' ? item.tokenTotal : undefined, verifyTimeSec: typeof item.verify_time_sec === 'number' ? item.verify_time_sec : typeof item.verifyTimeSec === 'number' ? item.verifyTimeSec : undefined });
    }
    return ok({ total: lines.length, entries });
  } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? ok({ total: 0, entries: [] }) : err('TRANSPORT_ERROR', 'Cannot read metrics.jsonl'); }
}

export function aggregate(entries: MetricsRecord[]): LearningEntry[] {
  const learnings = new Map<string, LearningEntry>();
  for (const entry of entries) {
    const modules = [...new Set((entry.files.length === 0 ? ['general'] : entry.files.map(moduleOf)))];
    for (const pattern of [...new Set(entry.errors.map(labelOf))]) for (const module of modules) {
      const key = `${pattern}::${module}`, seen = entry.timestamp.slice(0, 10), prev = learnings.get(key);
      learnings.set(key, { pattern, module, count: (prev?.count ?? 0) + 1, lastSeen: prev && prev.lastSeen > seen ? prev.lastSeen : seen, suggestion: `Add targeted tests or constraints to prevent ${pattern} in ${module}.` });
    }
  }
  return [...learnings.values()].sort(byValue).slice(0, 10);
}

export function addendumForTask(learnings: LearningEntry[], task: TaskDefinition): string {
  const modules = [...new Set(task.scope.editableFiles.map(moduleOf))];
  return addendum(learnings.filter(item => modules.includes(item.module)).sort(byValue).slice(0, 3));
}
