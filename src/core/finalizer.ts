// core/finalizer.ts — Post-merge finalization: behavior check, notifications, rebase.

import { ok, err, type Result } from '../shared/result.js';
import type {
  TaskDefinition, FinalizationState, NotificationType,
  GitAdapter, NotifierAdapter, TaskQueueAdapter,
  AgentloopConfig,
} from '../types/index.js';
import { detectBehaviorChanges } from './behavior.js';

interface FinalizeDeps {
  git: GitAdapter;
  notifier: NotifierAdapter;
  queue: TaskQueueAdapter;
  config: AgentloopConfig;
}

async function notify(
  d: FinalizeDeps, taskId: string | undefined, summary: string, details: string,
  type: NotificationType = 'escalation', idempotencyKey?: string,
): Promise<Result<void>> {
  const r = await d.notifier.send({ type, taskId, summary, details, timestamp: new Date().toISOString(), idempotencyKey });
  return r.ok ? ok(undefined) : err('NOTIFY_FAILED', r.error.message);
}

export async function finalize(
  d: FinalizeDeps, task: TaskDefinition, fin: FinalizationState, token: string,
): Promise<Result<void>> {
  const persist = async () => { fin.failCount = 0; return d.queue.updateFinalization(task.id, fin, token); };
  // Step 1: Detect behavior changes and send notification (idempotent via key)
  if (!fin.behaviorNotified) {
    const diff = await d.git.getDiff(`${fin.mergeCommit}~1`, fin.mergeCommit);
    if (!diff.ok) return diff;
    const behavior = detectBehaviorChanges(diff.value);
    if (behavior.hasChanges) {
      const n = await notify(d, task.id, behavior.changes.map(c => c.description).join('\n'),
        `Files: ${behavior.changes.flatMap(c => c.files).join(', ')}`, 'behavior-change',
        `behavior:${task.id}:${fin.mergeCommit}`);
      if (!n.ok) return n;
    }
    fin.behaviorNotified = true;
    const uf = await persist(); if (!uf.ok) return uf;
  }
  // Step 2: Ensure README update task if needed (idempotent via dedupeKey)
  if (!fin.readmeTaskEnsured) {
    const diff = await d.git.getDiff(`${fin.mergeCommit}~1`, fin.mergeCommit);
    if (!diff.ok) return diff;
    const behavior = detectBehaviorChanges(diff.value);
    if (behavior.readmeUpdateNeeded) {
      const et = await d.queue.ensureTask(`readme:${task.id}:${fin.mergeCommit}`, {
        title: `Update README for ${task.title}`, description: 'Behavior changes detected.',
        scope: { editableFiles: ['README.md'], readOnlyContext: [], forbiddenFiles: [] },
        acceptanceCriteria: ['README reflects current behavior'], model: 'auto', priority: 'medium',
      });
      if (!et.ok) return et as Result<never>;
    }
    fin.readmeTaskEnsured = true;
    const uf = await persist(); if (!uf.ok) return uf;
  }
  // Step 3: Send completion notification (idempotent via key)
  if (!fin.completionNotified) {
    const n = await notify(d, task.id, `Completed: ${task.title}`, 'Merged', 'promotion-ready',
      `promotion:${task.id}:${fin.mergeCommit}`);
    if (!n.ok) return n;
    fin.completionNotified = true;
    const uf = await persist(); if (!uf.ok) return uf;
  }
  // Step 4: Rebase other branches (idempotent — rebaseAll is a no-op if already rebased)
  if (!fin.rebaseDone) {
    const rb = await d.git.rebaseAll(d.config.baseBranch, fin.branch);
    if (!rb.ok) return rb;
    fin.rebaseDone = true;
    const uf = await persist(); if (!uf.ok) return uf;
  }
  return d.queue.markDone(task.id, token);
}
