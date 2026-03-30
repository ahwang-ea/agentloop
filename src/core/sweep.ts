// core/sweep.ts — Architect sweep: scan codebase against ARCHITECTURE.md, create tasks.

import { ok, err, type Result } from '../shared/result.js';
import type { ClaudeAdapter, NotifierAdapter, TaskQueueAdapter, AgentloopConfig } from '../types/index.js';
import { readFile } from 'node:fs/promises';
import { extractJson } from './review-output.js';
import { findSweepTasks } from './sweep-checks.js';
import { readInventory, writeInventory } from './scanner.js';

interface SweepDeps {
  claude: ClaudeAdapter;
  notifier: NotifierAdapter;
  queue: TaskQueueAdapter;
  config: AgentloopConfig;
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

  const previous = await readInventory(config.repoPath);
  if (!previous.ok) return previous;
  const scanned = await writeInventory(config.repoPath);
  if (!scanned.ok) return scanned;
  for (const item of findSweepTasks(agentsContent, archContent, scanned.value, previous.value)) {
    const created = await queue.ensureTask(item.dedupeKey, {
      title: item.title,
      description: item.description,
      scope: { editableFiles: item.editableFiles, readOnlyContext: [], forbiddenFiles: [] },
      acceptanceCriteria: [], model: 'auto', priority: 'low',
    });
    if (!created.ok) return created;
  }

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
    const addResult = await queue.ensureTask(`sweep:claude:${item.title}`, {
      title: item.title, description: item.description,
      scope: { editableFiles: item.editableFiles ?? ['**/*'], readOnlyContext: [], forbiddenFiles: [] },
      acceptanceCriteria: [], model: 'auto', priority: 'low',
    });
    if (!addResult.ok) return err(addResult.error.code, `Failed to create sweep task: ${addResult.error.message}`);
  }

  const n = await notifier.send({
    type: 'sweep-result',
    summary: `Architect sweep: ${proposed.length} tasks proposed`,
    details: proposed.map(item => item.title).join(', ') || 'No tasks proposed',
    timestamp: new Date().toISOString(),
  });
  if (!n.ok) return err(n.error.code, n.error.message);

  return ok(undefined);
}
