// core/review-loop.ts — Review phase: loop until clean or review-convergence stalls.

import { ok, err, type Result } from '../shared/result.js';
import type {
  ClaudeSession,
  CodexAdapter,
  ConvergenceState,
  NotifierAdapter,
  ReviewFinding,
  TaskDefinition,
  TaskStatus,
} from '../types/index.js';
import { refreshLearnings } from './learnings.js';
import { withLease } from './lease.js';
import { logTaskMetrics, recordReviewFindings, recordSessionChanges } from './metrics.js';
import { formatFixPrompt, resolveConflicts, runSequentialReviews } from './reviewer.js';
import { addTaskTokens, type TaskUsage } from './session-budget.js';
import { verifyLoop, type VerifyDeps } from './verify-loop.js';
import { runWriterFix } from './writer.js';

interface ReviewDeps extends VerifyDeps {
  codex: CodexAdapter;
  notifier: NotifierAdapter;
}
interface ReviewPass { count: number; hashes: string[]; }

const setStatus = (d: ReviewDeps, id: string, s: TaskStatus, token: string) => d.queue.updateStatus(id, s, token);
const hashFinding = (f: ReviewFinding) => [f.severity, f.reviewer, f.topicKey ?? '', f.action ?? '', f.file ?? '', f.line ?? '', f.description.trim().toLowerCase()].join(':');
const improved = (prev: string[], next: string[]) => {
  const prevSet = new Set(prev), nextSet = new Set(next);
  const resolved = prev.filter(hash => !nextSet.has(hash)).length;
  const introduced = next.filter(hash => !prevSet.has(hash)).length;
  return next.length < prev.length || (resolved > 0 && resolved >= introduced);
};

async function syncBlocked(d: ReviewDeps, task: TaskDefinition): Promise<void> {
  const logged = await logTaskMetrics(d.config, d.queue, task, 'blocked');
  if (!logged.ok) return void console.error(logged.error.message);
  const learned = await refreshLearnings(d.config, d.claude, d.notifier);
  if (!learned.ok) console.error(learned.error.message);
}

async function singleReviewPass(
  d: ReviewDeps, session: ClaudeSession | undefined, task: TaskDefinition,
  conv: ConvergenceState, t0: number, cwd: string, token: string, usage: TaskUsage,
): Promise<Result<ReviewPass>> {
  const diff = await d.git.getDiff(d.config.baseBranch, undefined, cwd); if (!diff.ok) return err(diff.error.code, diff.error.message);
  const reviews = await runSequentialReviews(d, task, diff.value); if (!reviews.ok) return err(reviews.error.code, reviews.error.message);
  const findings = reviews.value.flatMap(review => review.findings);
  if (findings.length === 0) return ok({ count: 0, hashes: [] });
  recordReviewFindings(conv, findings);
  const progress = await d.queue.updateProgress(task.id, { round: conv.rounds.length, convergence: conv }, token); if (!progress.ok) return progress;
  const resolved = resolveConflicts(findings); if (!resolved.ok) return resolved as Result<never>;
  const fixing = await setStatus(d, task.id, 'fixing', token); if (!fixing.ok) return fixing as Result<never>;
  const fix = await withLease(() => runWriterFix(d, session, task, formatFixPrompt(resolved.value), cwd), () => d.queue.renewClaim(task.id, token));
  if (!fix.ok) return err(fix.error.code, fix.error.message);
  addTaskTokens(usage, fix.value.tokenEstimate);
  recordSessionChanges(conv, fix.value.changedFiles);
  const saved = await d.queue.updateProgress(task.id, { round: conv.rounds.length, convergence: conv }, token); if (!saved.ok) return saved;
  const verified = await verifyLoop(d, session, task, fix.value.tokenEstimate, fix.value.changedFiles, conv, t0, cwd, token, usage);
  return verified.ok ? ok({ count: findings.length, hashes: [...new Set(findings.map(hashFinding))].sort() }) : verified;
}

export async function reviewPhase(
  d: ReviewDeps, session: ClaudeSession | undefined, task: TaskDefinition,
  conv: ConvergenceState, t0: number, cwd: string, token: string, usage: TaskUsage,
): Promise<Result<void>> {
  let prev: string[] | null = null, stalled = 0;
  const stallLimit = Math.max(1, d.config.convergence.stuckThreshold - 1);
  while (true) {
    if ((Date.now() - t0) / 1000 > d.config.convergence.maxWallClock) return err('BUDGET_EXCEEDED', 'Review wall clock exceeded');
    const result = await singleReviewPass(d, session, task, conv, t0, cwd, token, usage);
    if (!result.ok) {
      if (result.error.code === 'REVIEW_CONFLICT') {
        const blocked = await d.queue.markBlocked(task.id, result.error.message, result.error.details ?? {}, token);
        if (!blocked.ok) return blocked;
        await syncBlocked(d, task);
      }
      return result as Result<never>;
    }
    if (result.value.count === 0) return ok(undefined);
    stalled = prev && !improved(prev, result.value.hashes) ? stalled + 1 : 0;
    if (stalled >= stallLimit) {
      const reason = `Review findings stopped converging after ${stallLimit + 1} passes`;
      const blocked = await d.queue.markBlocked(task.id, reason, { findings: result.value.hashes }, token);
      if (!blocked.ok) return blocked;
      await syncBlocked(d, task);
      return err('REVIEW_STUCK', reason, { findings: result.value.hashes });
    }
    prev = result.value.hashes;
    const reviewing = await setStatus(d, task.id, 'reviewing', token); if (!reviewing.ok) return reviewing;
  }
}
