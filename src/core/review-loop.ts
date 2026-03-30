// core/review-loop.ts — Review phase: loop until clean or review-convergence stalls.

import { ok, err, type Result } from '../shared/result.js';
import type {
  TaskDefinition, ConvergenceState, TaskStatus, SessionOutput, ReviewFinding,
  ClaudeAdapter, ClaudeSession, CodexAdapter, GitAdapter, TaskQueueAdapter, AgentloopConfig,
} from '../types/index.js';
import { runParallelReviews, formatFixPrompt, resolveConflicts } from './reviewer.js';
import { verifyLoop, type VerifyDeps } from './verify-loop.js';
import { withLease } from './lease.js';

interface ReviewDeps extends VerifyDeps {
  claude: ClaudeAdapter;
  codex: CodexAdapter;
  git: GitAdapter;
  queue: TaskQueueAdapter;
  config: AgentloopConfig;
}
interface ReviewPass { count: number; hashes: string[]; }

const chk = (r: Result<SessionOutput>): Result<SessionOutput> =>
  r.ok && !r.value.text.trim() && r.value.changedFiles.length === 0
    ? err('EMPTY_RESPONSE', 'Agent returned empty output and changed no files') : r;
const setStatus = (d: ReviewDeps, id: string, s: TaskStatus, token: string) => d.queue.updateStatus(id, s, token);
const hashFinding = (f: ReviewFinding) => [f.severity, f.reviewer, f.topicKey ?? '', f.action ?? '', f.file ?? '', f.line ?? '', f.description.trim().toLowerCase()].join(':');
const improved = (prev: string[], next: string[]) => {
  const prevSet = new Set(prev), nextSet = new Set(next);
  const resolved = prev.filter(h => !nextSet.has(h)).length;
  const introduced = next.filter(h => !prevSet.has(h)).length;
  return next.length < prev.length || (resolved > 0 && resolved >= introduced);
};

async function singleReviewPass(
  d: ReviewDeps, session: ClaudeSession, task: TaskDefinition,
  conv: ConvergenceState, t0: number, cwd: string, token: string,
): Promise<Result<ReviewPass>> {
  const diff = await d.git.getDiff(d.config.baseBranch);
  if (!diff.ok) return err(diff.error.code, diff.error.message);
  const reviews = await runParallelReviews(d, task, diff.value);
  if (!reviews.ok) return err(reviews.error.code, reviews.error.message);
  const findings = reviews.value.flatMap(r => r.findings);
  if (findings.length === 0) return ok({ count: 0, hashes: [] });
  const resolved = resolveConflicts(findings);
  if (!resolved.ok) return resolved as Result<never>;
  const sf = await setStatus(d, task.id, 'fixing', token);
  if (!sf.ok) return sf as Result<never>;
  const fix = chk(await withLease(
    () => d.claude.fix(session, formatFixPrompt(resolved.value)),
    () => d.queue.renewClaim(task.id, token),
  ));
  if (!fix.ok) return err(fix.error.code, fix.error.message);
  const vl = await verifyLoop(d, session, task.id, fix.value.tokensDelta, conv, t0, cwd, token);
  if (!vl.ok) return vl as Result<never>;
  return ok({ count: findings.length, hashes: [...new Set(findings.map(hashFinding))].sort() });
}

export async function reviewPhase(
  d: ReviewDeps, session: ClaudeSession, task: TaskDefinition,
  conv: ConvergenceState, t0: number, cwd: string, token: string,
): Promise<Result<void>> {
  let prev: string[] | null = null, stalled = 0;
  const stallLimit = Math.max(1, d.config.convergence.stuckThreshold - 1);
  while (true) {
    if ((Date.now() - t0) / 1000 > d.config.convergence.maxWallClock)
      return err('BUDGET_EXCEEDED', 'Review wall clock exceeded');
    const r = await singleReviewPass(d, session, task, conv, t0, cwd, token);
    if (!r.ok) {
      if (r.error.code === 'REVIEW_CONFLICT') {
        const mb = await d.queue.markBlocked(task.id, r.error.message, r.error.details ?? {}, token);
        if (!mb.ok) return mb;
      }
      return r as Result<never>;
    }
    if (r.value.count === 0) return ok(undefined);
    stalled = prev && !improved(prev, r.value.hashes) ? stalled + 1 : 0;
    if (stalled >= stallLimit) {
      const reason = `Review findings stopped converging after ${stallLimit + 1} passes`;
      const mb = await d.queue.markBlocked(task.id, reason, { findings: r.value.hashes }, token);
      if (!mb.ok) return mb;
      return err('REVIEW_STUCK', reason, { findings: r.value.hashes });
    }
    prev = r.value.hashes;
    const s = await setStatus(d, task.id, 'reviewing', token);
    if (!s.ok) return s;
  }
}
