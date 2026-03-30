import type { ClaudeSession, ConvergenceState, FinalizationState, TaskDefinition } from '../types/index.js';
import type { Deps } from '../orchestrator.js';
import { ok, err, type Result } from '../shared/result.js';
import { recordSessionChanges, recordVerifyErrors } from './metrics.js';
import { addTaskTokens, type TaskUsage } from './session-budget.js';
import { withLease } from './lease.js';
import { reviewPhase } from './review-loop.js';
import { progressiveVerify } from './verifier.js';
import { verifyLoop } from './verify-loop.js';
import { runWriterCleanup, startWrite } from './writer.js';

export async function runTask(
  d: Deps, task: TaskDefinition, branch: string, mergeInto: string, worktreePath: string,
  seed: ConvergenceState | undefined, token: string, warmSession: ClaudeSession | undefined, usage: TaskUsage,
): Promise<Result<void>> {
  const conv = seed ?? {
    rounds: [],
    classification: 'unknown' as const,
    webSearchTriggered: false,
    reviewFindings: 0,
    errorTypes: [],
    changedFiles: [],
  };
  const t0 = Date.now();
  const started = await withLease(() => startWrite(d, task, worktreePath, warmSession), () => d.queue.renewClaim(task.id, token));
  if (!started.ok) return err(started.error.code, started.error.message);
  usage.session = started.value.session;
  addTaskTokens(usage, started.value.output.tokenEstimate);
  recordSessionChanges(conv, started.value.output.changedFiles);
  let p = await d.queue.updateProgress(task.id, { round: conv.rounds.length, convergence: conv }, token); if (!p.ok) return p;
  let s = await d.queue.updateStatus(task.id, 'verifying', token); if (!s.ok) return s;
  let r = await verifyLoop(d, started.value.session, task, started.value.output.tokenEstimate, started.value.output.changedFiles, conv, t0, worktreePath, token, usage); if (!r.ok) return r;
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
  const fv = await progressiveVerify(d.config, conv.changedFiles, worktreePath, true); if (!fv.ok) return fv;
  if (!fv.value.pass) {
    recordVerifyErrors(conv, fv.value.errors);
    p = await d.queue.updateProgress(task.id, { round: conv.rounds.length, convergence: conv }, token); if (!p.ok) return p;
    return err('VERIFY_FAILED', 'Final verify failed before merge');
  }
  s = await d.queue.updateStatus(task.id, 'merging', token); if (!s.ok) return s;
  const commit = await d.git.commit(`feat: ${task.title}`, branch); if (!commit.ok) return commit;
  const co = await d.git.checkoutBase(mergeInto); if (!co.ok) return err(co.error.code, `checkoutBase failed: ${co.error.message}`, co.error.details);
  const merge = await d.git.merge(branch, mergeInto);
  if (!merge.ok) {
    const ab = await d.git.abortMerge(mergeInto);
    if (!ab.ok) return err(merge.error.code, `${merge.error.message}; abortMerge also failed: ${ab.error.message}`, { mergeError: merge.error, abortError: ab.error });
    return err(merge.error.code, merge.error.message, merge.error.details);
  }
  const fin: FinalizationState = {
    mergeCommit: merge.value,
    branch,
    mergeInto,
    featureBranch: task.feature ? mergeInto : undefined,
    approvalRequested: !task.feature,
    approved: !task.feature,
    featureMerged: !task.feature,
    intentChecked: !task.feature,
    behaviorNotified: false,
    readmeTaskEnsured: false,
    completionNotified: false,
    rebaseDone: false,
    failCount: 0,
  };
  const bf = await d.queue.beginFinalization(task.id, fin, token);
  return bf.ok ? ok(undefined) : err('FINALIZATION_PERSIST_FAILED', `Merge succeeded (${merge.value}) but beginFinalization failed: ${bf.error.message}`, { mergeCommit: merge.value, branch });
}
