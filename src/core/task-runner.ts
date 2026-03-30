import type { ClaudeSession, ConvergenceState, TaskDefinition } from '../types/index.js';
import type { Deps } from '../orchestrator.js';
import { ok, err, type Result } from '../shared/result.js';
import { recordSessionChanges, recordVerifyErrors } from './metrics.js';
import { addTaskTokens, type TaskUsage } from './session-budget.js';
import { withLease } from './lease.js';
import { reviewPhase } from './review-loop.js';
import { scaffoldTask } from './scaffold.js';
import { commitAndMergeTask } from './task-merge.js';
import { progressiveVerify } from './verifier.js';
import { verifyLoop } from './verify-loop.js';
import { runWriterCleanup, startWrite } from './writer.js';

export async function runTask(
  d: Deps, task: TaskDefinition, branch: string, mergeInto: string, worktreePath: string,
  seed: ConvergenceState | undefined, token: string, warmSession: ClaudeSession | undefined, usage: TaskUsage, shouldScaffold: boolean,
): Promise<Result<void>> {
  const conv = seed ?? { rounds: [], classification: 'unknown' as const, webSearchTriggered: false, reviewFindings: 0, errorTypes: [], changedFiles: [] };
  const t0 = Date.now();
  const scaffolded = shouldScaffold
    ? await withLease(() => scaffoldTask(d.claude, task, worktreePath), () => d.queue.renewClaim(task.id, token))
    : ok([]);
  if (!scaffolded.ok) return scaffolded;
  const started = await withLease(() => startWrite(d, task, worktreePath, warmSession), () => d.queue.renewClaim(task.id, token));
  if (!started.ok) return err(started.error.code, started.error.message);
  usage.session = started.value.session;
  addTaskTokens(usage, started.value.output.tokenEstimate);
  const initialFiles = [...new Set([...scaffolded.value, ...started.value.output.changedFiles])];
  recordSessionChanges(conv, initialFiles);
  let p = await d.queue.updateProgress(task.id, { round: conv.rounds.length, convergence: conv }, token); if (!p.ok) return p;
  let s = await d.queue.updateStatus(task.id, 'verifying', token); if (!s.ok) return s;
  let r = await verifyLoop(d, started.value.session, task, started.value.output.tokenEstimate, initialFiles, conv, t0, worktreePath, token, usage); if (!r.ok) return r;
  s = await d.queue.updateStatus(task.id, 'reviewing', token); if (!s.ok) return s;
  r = await reviewPhase(d, started.value.session, task, conv, t0, worktreePath, token, usage); if (!r.ok) return r;
  s = await d.queue.updateStatus(task.id, 'cleanup', token); if (!s.ok) return s;
  const cleanup = await withLease(() => runWriterCleanup(d, started.value.session, task, worktreePath), () => d.queue.renewClaim(task.id, token));
  if (!cleanup.ok) return err(cleanup.error.code, cleanup.error.message);
  addTaskTokens(usage, cleanup.value.tokenEstimate);
  recordSessionChanges(conv, cleanup.value.changedFiles);
  p = await d.queue.updateProgress(task.id, { round: conv.rounds.length, convergence: conv }, token); if (!p.ok) return p;
  s = await d.queue.updateStatus(task.id, 'verifying', token); if (!s.ok) return s;
  r = await verifyLoop(d, started.value.session, task, cleanup.value.tokenEstimate, cleanup.value.changedFiles, conv, t0, worktreePath, token, usage); if (!r.ok) return r;
  const fv = await progressiveVerify(d.config, conv.changedFiles, worktreePath, true, task.type); if (!fv.ok) return fv;
  if (!fv.value.pass) {
    recordVerifyErrors(conv, fv.value.errors);
    p = await d.queue.updateProgress(task.id, { round: conv.rounds.length, convergence: conv }, token); if (!p.ok) return p;
    return err('VERIFY_FAILED', 'Final verify failed before merge');
  }
  s = await d.queue.updateStatus(task.id, 'merging', token); if (!s.ok) return s;
  return commitAndMergeTask(d.git, d.queue, task, branch, mergeInto, token, `feat: ${task.title}`);
}
