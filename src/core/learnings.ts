import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, ClaudeAdapter, LearningEntry, MetricsRecord, NotifierAdapter, TaskDefinition } from '../types/index.js';
import { withArtifactLock, writeTextAtomically } from './artifact-lock.js';
import { metricsPath } from './metrics.js';
import { asNumber, asObjectArray, asString, parseJson, unwrapVersioned } from './persisted-json.js';

const pathOf = (c: Pick<AgentloopConfig, 'repoPath'>, file: string) => join(c.repoPath, '.agentloop', file);
const agentsPath = (c: Pick<AgentloopConfig, 'repoPath' | 'agentsMdPath'>) => isAbsolute(c.agentsMdPath) ? c.agentsMdPath : join(c.repoPath, c.agentsMdPath);
const moduleOf = (path: string) => {
  const parts = path.split('/').filter(Boolean), src = parts.lastIndexOf('src');
  const raw = src >= 0 && parts[src + 1] ? parts[src + 1] : parts[0] ?? 'general';
  return raw.replace(/\.[^.]+$/, '').replace(/\.test$/, '') || 'general';
};
const labelOf = (pattern: string) => pattern.replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || 'unknown issue';
const keyOf = (item: Pick<LearningEntry, 'pattern' | 'module'>) => `${item.pattern}::${item.module}`;
const byValue = (a: LearningEntry, b: LearningEntry) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen) || a.pattern.localeCompare(b.pattern);
const addendum = (items: LearningEntry[]) => items.length === 0 ? '' : ['Common mistakes in this area:', ...items.map(item => `- ${item.pattern} (seen ${item.count} times)`)].join('\n');
const lineCount = (text: string) => (text.replace(/\n$/, '') || '').split('\n').filter(Boolean).length;
const proposalPrompt = (agentsMd: string, entries: MetricsRecord[], retry?: string) => [
  'Propose a unified diff against the current AGENTS.md based on the recent task metrics.',
  'Return ONLY the diff. Keep the resulting AGENTS.md under 100 lines.',
  'For each proposed rule, prefer a lint rule, test helper, or type constraint over prose when possible.',
  'If adding a rule would exceed 100 lines, remove the least-valuable existing rule in the diff.',
  retry ?? '',
  '',
  'Current AGENTS.md:',
  agentsMd,
  '',
  'Recent metrics (last 20):',
  JSON.stringify(entries, null, 2),
].filter(Boolean).join('\n');

async function readLearnings(path: string): Promise<Result<LearningEntry[]>> {
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
async function readText(path: string, fallback = ''): Promise<Result<string>> {
  try { return ok(await readFile(path, 'utf-8')); }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? ok(fallback) : err('TRANSPORT_ERROR', `Cannot read ${path}`); }
}
async function recentMetrics(config: Pick<AgentloopConfig, 'repoPath'>): Promise<Result<{ total: number; entries: MetricsRecord[] }>> {
  try {
    const path = metricsPath(config), lines = (await readFile(path, 'utf-8')).trim().split('\n').filter(Boolean), entries: MetricsRecord[] = [];
    for (const line of lines.slice(-20)) {
      const parsed = parseJson(line, path); if (!parsed.ok) return err('TRANSPORT_ERROR', 'Cannot read metrics.jsonl');
      const item = parsed.value as Partial<MetricsRecord> & { time_sec?: number; review_findings?: number; task_type?: MetricsRecord['taskType']; token_total?: number; verify_time_sec?: number; };
      if (typeof item.task_id !== 'string' || typeof item.task !== 'string' || typeof item.timestamp !== 'string') return err('TRANSPORT_ERROR', 'Cannot read metrics.jsonl');
      entries.push({ version: item.version === 2 ? 2 : undefined, task_id: item.task_id, task: item.task, rounds: typeof item.rounds === 'number' ? item.rounds : 0, timeSec: typeof item.time_sec === 'number' ? item.time_sec : 0, reviewFindings: typeof item.review_findings === 'number' ? item.review_findings : 0, outcome: item.outcome ?? 'blocked', errors: Array.isArray(item.errors) ? item.errors.filter((value): value is string => typeof value === 'string') : [], files: Array.isArray(item.files) ? item.files.filter((value): value is string => typeof value === 'string') : [], timestamp: item.timestamp, taskType: item.task_type ?? item.taskType, tokenTotal: typeof item.token_total === 'number' ? item.token_total : typeof item.tokenTotal === 'number' ? item.tokenTotal : undefined, verifyTimeSec: typeof item.verify_time_sec === 'number' ? item.verify_time_sec : typeof item.verifyTimeSec === 'number' ? item.verifyTimeSec : undefined });
    }
    return ok({ total: lines.length, entries });
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? ok({ total: 0, entries: [] }) : err('TRANSPORT_ERROR', 'Cannot read metrics.jsonl');
  }
}
function aggregate(entries: MetricsRecord[]): LearningEntry[] {
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
function projectedLines(current: string, diff: string): Result<number> {
  if (!/^--- .*AGENTS\.md$/m.test(diff) || !/^\+\+\+ .*AGENTS\.md$/m.test(diff)) return err('EMPTY_RESPONSE', 'Claude response was not a diff against AGENTS.md');
  let total = lineCount(current);
  for (const line of diff.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) total += 1;
    if (line.startsWith('-')) total -= 1;
  }
  return ok(total);
}
async function requestProposal(claude: Pick<ClaudeAdapter, 'chat'>, agentsMd: string, entries: MetricsRecord[], retry?: string): Promise<Result<string>> {
  const response = await claude.chat(proposalPrompt(agentsMd, entries, retry)); if (!response.ok) return response;
  return response.value.text.trim() ? ok(response.value.text.trim()) : err('EMPTY_RESPONSE', 'Claude returned no AGENTS.md proposal');
}

export async function syncLearnings(config: Pick<AgentloopConfig, 'repoPath'>): Promise<Result<LearningEntry[]>> {
  const target = pathOf(config, 'learnings.json');
  return withArtifactLock(target, 'learnings', async () => {
    const recent = await recentMetrics(config); if (!recent.ok) return recent;
    const next = aggregate(recent.value.entries), current = await readText(target); if (!current.ok) return current;
    const serialized = JSON.stringify(next, null, 2), saved = current.value.trim() === serialized.trim() ? ok(undefined) : await writeTextAtomically(target, serialized);
    return saved.ok ? ok(next) : saved;
  });
}

export async function learningsAddendum(config: Pick<AgentloopConfig, 'repoPath'>, task: TaskDefinition): Promise<Result<string>> {
  const learnings = await readLearnings(pathOf(config, 'learnings.json')); if (!learnings.ok) return learnings;
  const modules = [...new Set(task.scope.editableFiles.map(moduleOf))];
  return ok(addendum(learnings.value.filter(item => modules.includes(item.module)).sort(byValue).slice(0, 3)));
}

export async function maybeProposeAgentsUpdate(
  config: Pick<AgentloopConfig, 'repoPath' | 'agentsMdPath'>, claude: Pick<ClaudeAdapter, 'chat'>, notifier: Pick<NotifierAdapter, 'send'>,
): Promise<Result<boolean>> {
  const recent = await recentMetrics(config); if (!recent.ok || recent.value.total === 0 || recent.value.total % 20 !== 0) return recent.ok ? ok(false) : recent;
  const proposal = pathOf(config, 'proposed-agents-update.md');
  const existing = await readText(proposal); if (!existing.ok) return existing;
  if (existing.value.trim()) return ok(false);
  const agentsMd = await readText(agentsPath(config)); if (!agentsMd.ok) return err('TRANSPORT_ERROR', 'Cannot read AGENTS.md for proposal generation');
  let diff = await requestProposal(claude, agentsMd.value, recent.value.entries); if (!diff.ok) return diff;
  let projected = projectedLines(agentsMd.value, diff.value);
  if (!projected.ok || projected.value > 100) {
    const note = `The previous diff was invalid or projected ${projected.ok ? projected.value : 'too many'} lines. Rewrite it as a unified diff against AGENTS.md that keeps the result at 100 lines or fewer by removing the least-valuable existing rule if needed.\n\nPrevious diff:\n${diff.value}`;
    diff = await requestProposal(claude, agentsMd.value, recent.value.entries, note); if (!diff.ok) return diff;
    projected = projectedLines(agentsMd.value, diff.value);
  }
  if (!projected.ok) return projected;
  if (projected.value > 100) return err('CONFIG_ERROR', `Proposed AGENTS.md update exceeds 100 lines (${projected.value})`);
  const wrote = await withArtifactLock(proposal, 'proposal', async () => {
    const current = await readText(proposal); if (!current.ok) return current;
    if (current.value.trim()) return ok(false);
    const saved = await writeTextAtomically(proposal, diff.value);
    return saved.ok ? ok(true) : saved;
  });
  if (!wrote.ok || !wrote.value) return wrote;
  const sent = await notifier.send({ type: 'promotion-ready', summary: 'AGENTS.md update proposed. Review in repo.', details: `Review ${proposal}`, timestamp: new Date().toISOString(), idempotencyKey: `agents-proposal:${recent.value.total}` });
  return sent.ok ? ok(true) : sent;
}

export async function refreshLearnings(
  config: Pick<AgentloopConfig, 'repoPath' | 'agentsMdPath'>, claude: Pick<ClaudeAdapter, 'chat'>, notifier: Pick<NotifierAdapter, 'send'>,
): Promise<Result<void>> {
  const synced = await syncLearnings(config); if (!synced.ok) return synced;
  const proposed = await maybeProposeAgentsUpdate(config, claude, notifier);
  return proposed.ok ? ok(undefined) : proposed;
}
