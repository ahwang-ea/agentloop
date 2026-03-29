// orchestrator.ts — Core state machine. Each transition is code, not a prompt.
import type {
  AgentloopConfig, TaskDefinition, FinalizationState, ClaimedActionableTask, ConvergenceState, SessionOutput,
  ClaudeAdapter, CodexAdapter, GitAdapter, NotifierAdapter, TaskQueueAdapter,
} from './types/index.js';
import { ok, err, type Result } from './shared/result.js';
import { runVerify } from './core/verifier.js';
import { architectSweep } from './core/sweep.js';
import { verifyLoop } from './core/verify-loop.js';
import { reviewPhase } from './core/review-loop.js';
import { finalize } from './core/finalizer.js';
import { withLease } from './core/lease.js';

export interface Deps { claude: ClaudeAdapter; codex: CodexAdapter; git: GitAdapter; notifier: NotifierAdapter; queue: TaskQueueAdapter; config: AgentloopConfig; }
const MAX_FINALIZE_RETRIES = 3;
const slugify = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
const chk = (r: Result<SessionOutput>): Result<SessionOutput> =>
  r.ok && !r.value.text.trim() && r.value.changedFiles.length === 0 ? err('EMPTY_RESPONSE', 'Agent returned empty output and changed no files') : r;

async function notify(d: Deps, taskId: string | undefined, summary: string, details: string,
  type: 'escalation' | 'behavior-change' | 'sweep-result' | 'promotion-ready' = 'escalation', idempotencyKey?: string): Promise<Result<void>> {
  const r = await d.notifier.send({ type, taskId, summary, details, timestamp: new Date().toISOString(), idempotencyKey });
  return r.ok ? ok(undefined) : err('NOTIFY_FAILED', r.error.message);
}
async function escalate(d: Deps, task: TaskDefinition, reason: string, token: string): Promise<Result<void>> {
  const s = await d.queue.markStuck(task.id, reason, token);
  return s.ok ? notify(d, task.id, `Stuck: ${task.title}`, reason) : err(s.error.code, `markStuck: ${s.error.message}`);
}
async function claim(d: Deps): Promise<Result<ClaimedActionableTask | null>> {
  while (true) {
    const c = await d.queue.claimNextActionable(d.config.maxParallelAgents);
    if (c.ok || c.error.code !== 'QUEUE_CORRUPT') return c;
    await notify(d, undefined, 'Queue corrupted', c.error.message);
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}

export async function runOrchestrator(deps: Deps): Promise<Result<void>> {
  if (!deps.config.codexEnabled) {
    return err('CONFIG_ERROR', 'Parallel Opus + Codex review is required by ARCHITECTURE.md');
  }
  let sweepCounter = 0;
  while (true) {
    let claimed: ClaimedActionableTask;
    const c = await claim(deps);
    if (!c.ok) { await notify(deps, undefined, `Queue error: ${c.error.code}`, c.error.message); return c; }
    if (c.value) claimed = c.value;
    else {
      const sw = await architectSweep(deps); if (!sw.ok) return sw;
      const post = await claim(deps); if (!post.ok) return post;
      if (!post.value) return ok(undefined);
      claimed = post.value;
    }
    const { state, claimToken } = claimed;
    if (state.status === 'finalizing') {
      const f = await finalize(deps, state.task, state.finalization, claimToken);
      if (!f.ok) {
        const updated: FinalizationState = { ...state.finalization, failCount: state.finalization.failCount + 1 };
        const uf = await deps.queue.updateFinalization(state.task.id, updated, claimToken); if (!uf.ok) return uf;
        if (updated.failCount >= MAX_FINALIZE_RETRIES) {
          const e = await escalate(deps, state.task, `Finalization failed ${MAX_FINALIZE_RETRIES}x: ${f.error.message}`, claimToken);
          if (!e.ok) return e;
        } else {
          const rc = await deps.queue.releaseClaim(state.task.id, claimToken); if (!rc.ok) return rc;
        }
      }
      continue;
    }
    const branch = state.branch ?? `task/${state.task.id}-${slugify(state.task.title)}`;
    const checkout = state.branch ? await deps.git.checkoutBranch(branch) : await deps.git.createBranch(branch, deps.config.baseBranch);
    if (!checkout.ok) { const e = await escalate(deps, state.task, checkout.error.message, claimToken); if (!e.ok) return e; continue; }
    const sp = await deps.queue.updateProgress(state.task.id, { branch, round: state.round, convergence: state.convergence }, claimToken);
    if (!sp.ok) return sp;
    const result = await runTask(deps, state.task, branch, state.convergence, claimToken);
    if (!result.ok) {
      if (result.error.code === 'FINALIZATION_PERSIST_FAILED') {
        const e = await escalate(deps, state.task, result.error.message, claimToken); if (!e.ok) return e; continue;
      }
      if (result.error.code === 'REVIEW_CONFLICT' || result.error.code === 'REVIEW_STUCK') continue;
      let reason = result.error.message;
      if (result.error.code !== 'MERGE_CONFLICT') {
        const ab = await deps.git.abandonBranch(branch); if (!ab.ok) reason += `; abandonBranch: ${ab.error.message}`;
      }
      const e = await escalate(deps, state.task, reason, claimToken); if (!e.ok) return e; continue;
    }
    if (++sweepCounter >= deps.config.sweepInterval) { sweepCounter = 0; const sw = await architectSweep(deps); if (!sw.ok) return sw; }
  }
}

async function runTask(d: Deps, task: TaskDefinition, branch: string, seed: ConvergenceState | undefined, token: string): Promise<Result<void>> {
  const conv = seed ?? { rounds: [], classification: 'unknown' as const, webSearchTriggered: false };
  const t0 = Date.now();
  const session = await d.claude.startSession(task); if (!session.ok) return session;
  const stopped = chk(await withLease(() => d.claude.waitForStop(session.value), () => d.queue.renewClaim(task.id, token)));
  if (!stopped.ok) return err(stopped.error.code, stopped.error.message);
  let s = await d.queue.updateStatus(task.id, 'verifying', token); if (!s.ok) return s;
  let r = await verifyLoop(d, session.value, task.id, stopped.value.tokensDelta, conv, t0, token); if (!r.ok) return r;
  s = await d.queue.updateStatus(task.id, 'reviewing', token); if (!s.ok) return s;
  r = await reviewPhase(d, session.value, task, conv, t0, token); if (!r.ok) return r;
  s = await d.queue.updateStatus(task.id, 'cleanup', token); if (!s.ok) return s;
  const cleanup = chk(await withLease(() => d.claude.cleanup(session.value), () => d.queue.renewClaim(task.id, token)));
  if (!cleanup.ok) return err(cleanup.error.code, cleanup.error.message);
  s = await d.queue.updateStatus(task.id, 'verifying', token); if (!s.ok) return s;
  r = await verifyLoop(d, session.value, task.id, cleanup.value.tokensDelta, conv, t0, token); if (!r.ok) return r;
  const fv = await runVerify(d.config.verifyCommand); if (!fv.ok || !fv.value.pass) return err('VERIFY_FAILED', 'Final verify failed before merge');
  s = await d.queue.updateStatus(task.id, 'merging', token); if (!s.ok) return s;
  const commit = await d.git.commit(`feat: ${task.title}`); if (!commit.ok) return commit;
  const co = await d.git.checkoutBase(d.config.baseBranch); if (!co.ok) return err(co.error.code, `checkoutBase failed: ${co.error.message}`, co.error.details);
  const merge = await d.git.merge(branch, d.config.baseBranch);
  if (!merge.ok) {
    const ab = await d.git.abortMerge();
    if (!ab.ok) return err(merge.error.code, `${merge.error.message}; abortMerge also failed: ${ab.error.message}`, { mergeError: merge.error, abortError: ab.error });
    return err(merge.error.code, merge.error.message, merge.error.details);
  }
  const fin: FinalizationState = { mergeCommit: merge.value, branch, behaviorNotified: false, readmeTaskEnsured: false, completionNotified: false, rebaseDone: false, failCount: 0 };
  const bf = await d.queue.beginFinalization(task.id, fin, token);
  return bf.ok ? ok(undefined) : err('FINALIZATION_PERSIST_FAILED', `Merge succeeded (${merge.value}) but beginFinalization failed: ${bf.error.message}`, { mergeCommit: merge.value, branch });
}
