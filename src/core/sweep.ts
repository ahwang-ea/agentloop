// core/sweep.ts — Architect sweep: scan codebase against ARCHITECTURE.md, create tasks.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ok, err, type Result } from '../shared/result.js';
import type { AgentloopConfig, ClaudeAdapter, NotifierAdapter, TaskQueueAdapter } from '../types/index.js';
import { extractJson } from './review-output.js';
import { readInventory, writeInventory } from './scanner.js';
import { findSweepTasks } from './sweep-checks.js';

interface SweepDeps {
  claude: ClaudeAdapter;
  notifier: NotifierAdapter;
  queue: TaskQueueAdapter;
  config: AgentloopConfig;
}

const SWEEP_LIMIT = 10;
const sweepPrefix = 'sweep:';
const sweepKey = (title: string) => `sweep:claude:${createHash('sha256').update(title.trim().toLowerCase()).digest('hex').slice(0, 12)}`;
const sweepTask = (title: string, description: string, editableFiles: string[]) => ({
  title,
  description,
  scope: { editableFiles, readOnlyContext: [], forbiddenFiles: [] },
  acceptanceCriteria: [],
  model: 'auto' as const, type: 'implement' as const,
  priority: 'low' as const,
});

async function enqueueSweepTask(queue: TaskQueueAdapter, count: number, dedupeKey: string,
  task: ReturnType<typeof sweepTask>, created: string[]): Promise<Result<number>> {
  if (count >= SWEEP_LIMIT) return ok(count);
  const ensured = await queue.ensureTask(dedupeKey, task);
  if (!ensured.ok) return ensured;
  const next = await queue.countByDedupePrefix(sweepPrefix);
  if (!next.ok) return next;
  if (next.value > count) created.push(task.title);
  return next;
}

export async function architectSweep(deps: SweepDeps): Promise<Result<void>> {
  const { claude, notifier, queue, config } = deps;
  let archContent: string;
  let agentsContent = '';
  if (!config.architectureMdPath) return ok(undefined);
  try {
    archContent = await readFile(config.architectureMdPath, 'utf-8');
    agentsContent = await readFile(config.agentsMdPath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ok(undefined);
    return err('TRANSPORT_ERROR', `Cannot read ${config.architectureMdPath} — required for sweep`);
  }

  const previous = await readInventory(config.repoPath); if (!previous.ok) return previous;
  const scanned = await writeInventory(config.repoPath); if (!scanned.ok) return scanned;
  const count = await queue.countByDedupePrefix(sweepPrefix); if (!count.ok) return count;
  const created: string[] = [];
  let sweepCount = count.value;

  for (const item of findSweepTasks(agentsContent, archContent, scanned.value, previous.value)) {
    const next = await enqueueSweepTask(queue, sweepCount, item.dedupeKey, sweepTask(item.title, item.description, item.editableFiles), created);
    if (!next.ok) return next;
    sweepCount = next.value;
    if (sweepCount >= SWEEP_LIMIT) break;
  }

  if (sweepCount < SWEEP_LIMIT) {
    const prompt = [
      'Review this codebase against ARCHITECTURE.md.',
      'List any violations, gaps, or tasks that should be created.',
      'Avoid duplicating deterministic tasks for undocumented env vars, missing module docs, and newly oversized files.',
      'Return ONLY a JSON array of {title, description, editableFiles} objects.',
      '', 'ARCHITECTURE.md:', archContent,
      '', 'AGENTS.md:', agentsContent,
      '', 'inventory.json:', JSON.stringify(scanned.value, null, 2),
    ].join('\n');

    const result = await claude.chat(prompt);
    if (!result.ok) return err(result.error.code, `Sweep chat failed: ${result.error.message}`);
    if (!result.value.text.trim()) return err('EMPTY_RESPONSE', 'Architect sweep returned empty response');
    const json = extractJson(result.value.text);
    if (!json) return err('SWEEP_PARSE_ERROR', 'Sweep response contained no JSON');
    let proposed: unknown;
    try { proposed = JSON.parse(json); }
    catch { return err('SWEEP_PARSE_ERROR', `Sweep response contained malformed JSON: ${json.slice(0, 200)}`); }
    if (!Array.isArray(proposed)) return err('SWEEP_PARSE_ERROR', 'Sweep response JSON was not an array');

    for (const item of proposed as { title: string; description: string; editableFiles?: string[] }[]) {
      const next = await enqueueSweepTask(queue, sweepCount, sweepKey(item.title), sweepTask(item.title, item.description, item.editableFiles ?? ['**/*']), created);
      if (!next.ok) return err(next.error.code, `Failed to create sweep task: ${next.error.message}`);
      sweepCount = next.value;
      if (sweepCount >= SWEEP_LIMIT) break;
    }
  }

  const n = await notifier.send({
    type: 'sweep-result',
    summary: `Architect sweep: ${created.length} tasks queued`,
    details: created.join(', ') || (sweepCount >= SWEEP_LIMIT ? 'Sweep cap reached' : 'No new tasks queued'),
    timestamp: new Date().toISOString(),
  });
  return n.ok ? ok(undefined) : err(n.error.code, n.error.message);
}
