// orchestrator.ts — Core state machine. Each transition is code, not a prompt.
import type {
  AgentloopConfig,
  ClaimedActionableTask,
  ClaudeAdapter,
  CodexAdapter,
  FinalizationState,
  GitAdapter,
  NotifierAdapter,
  TaskDefinition,
  TaskQueueAdapter,
} from './types/index.js';
import { ok, err, type Result } from './shared/result.js';
import { finalize } from './core/finalizer.js';
import { featureBranchName } from './core/feature.js';
import { logTaskMetrics } from './core/metrics.js';
import { architectSweep } from './core/sweep.js';
import { emptyWarmSession, newTaskUsage, pickWarmSession, recordWarmSession, type WarmSessionState } from './core/session-budget.js';
import { runTask } from './core/task-runner.js';
import { taskBranchName, worktreePathForBranch } from './core/worktree.js';

export interface Deps {
  claude: ClaudeAdapter;
  codex: CodexAdapter;
  git: GitAdapter;
  notifier: NotifierAdapter;
  queue: TaskQueueAdapter;
  config: AgentloopConfig;
}
interface SharedState { sweepCounter: number; sweep?: Promise<Result<void>>; }
interface WorkerState { warm: WarmSessionState; }
const MAX_FINALIZE_RETRIES = 3;
const pending = new Set(['queued', 'writing', 'verifying', 'reviewing', 'fixing', 'cleanup', 'merging', 'finalizing']);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function notify(d: Deps, taskId: string | undefined, summary: string, details: string,
  type: 'escalation' | 'behavior-change' | 'sweep-result' | 'promotion-ready' = 'escalation', idempotencyKey?: string): Promise<Result<void>> {
  const r = await d.notifier.send({ type, taskId, summary, details, timestamp: new Date().toISOString(), idempotencyKey });
  return r.ok ? ok(undefined) : err('NOTIFY_FAILED', r.error.message);
}
async function escalate(d: Deps, task: TaskDefinition, reason: string, token: string): Promise<Result<boolean>> {
  const stuck = await d.queue.markStuck(task.id, reason, token);
  if (!stuck.ok) return err(stuck.error.code, `markStuck: ${stuck.error.message}`);
  const logged = await logTaskMetrics(d.config, d.queue, task, 'stuck'); if (!logged.ok) console.error(logged.error.message);
  const notice = await notify(d, task.id, `Stuck: ${task.title}`, reason);
  return notice.ok ? ok(false) : notice;
}
async function claim(d: Deps): Promise<Result<ClaimedActionableTask | null>> {
  while (true) {
    const c = await d.queue.claimNextActionable(d.config.maxParallelAgents);
    if (c.ok || c.error.code !== 'QUEUE_CORRUPT') return c;
    await notify(d, undefined, 'Queue corrupted', c.error.message);
    await sleep(1_000);
  }
}
async function runSweep(d: Deps, shared: SharedState): Promise<Result<void>> {
  if (!shared.sweep) shared.sweep = (async () => {
    const result = await architectSweep(d); shared.sweep = undefined; return result;
  })();
  return shared.sweep;
}
async function waitForWork(d: Deps, shared: SharedState): Promise<Result<'retry' | 'stop'>> {
  const tasks = await d.queue.list(); if (!tasks.ok) return tasks;
  if (tasks.value.some(task => pending.has(task.status))) { await sleep(250); return ok('retry'); }
  const swept = await runSweep(d, shared); if (!swept.ok) return swept;
  const refreshed = await d.queue.list(); if (!refreshed.ok) return refreshed;
  return ok(refreshed.value.some(task => pending.has(task.status)) ? 'retry' : 'stop');
}
async function maybeSweep(d: Deps, shared: SharedState): Promise<Result<void>> {
  if (++shared.sweepCounter < d.config.sweepInterval) return ok(undefined);
  shared.sweepCounter = 0;
  return runSweep(d, shared);
}
async function handleClaim(d: Deps, claimed: ClaimedActionableTask, worker: WorkerState): Promise<Result<boolean>> {
  const { state, claimToken } = claimed;
  if (state.status === 'finalizing') {
    const done = await finalize(d, state.task, state.finalization, claimToken);
    if (done.ok) return ok(false);
    const updated: FinalizationState = { ...state.finalization, failCount: state.finalization.failCount + 1 };
    const saved = await d.queue.updateFinalization(state.task.id, updated, claimToken); if (!saved.ok) return saved;
    if (updated.failCount >= MAX_FINALIZE_RETRIES) return escalate(d, state.task, `Finalization failed ${MAX_FINALIZE_RETRIES}x: ${done.error.message}`, claimToken);
    const released = await d.queue.releaseClaim(state.task.id, claimToken);
    return released.ok ? ok(false) : released;
  }
  const feature = state.task.feature ? await d.git.createBranch(featureBranchName(state.task.feature), d.config.baseBranch) : null;
  if (feature && !feature.ok) return escalate(d, state.task, feature.error.message, claimToken);
  const base = feature?.value.name ?? d.config.baseBranch;
  const created = state.branch ? null : await d.git.createBranch(taskBranchName(state.task), base);
  if (created && !created.ok) return escalate(d, state.task, created.error.message, claimToken);
  const branch = state.branch ?? created!.value.name;
  const worktreePath = state.branch ? worktreePathForBranch(d.config, branch) : created!.value.worktreePath;
  const checkout = state.branch ? await d.git.checkoutBranch(branch) : ok(undefined);
  if (!checkout.ok) return escalate(d, state.task, checkout.error.message, claimToken);
  const progress = await d.queue.updateProgress(state.task.id, { branch, round: state.round, convergence: state.convergence }, claimToken);
  if (!progress.ok) return progress;
  const usage = newTaskUsage();
  const result = await runTask(d, state.task, branch, base, worktreePath, state.convergence, claimToken, pickWarmSession(worker.warm, state.task.feature), usage);
  worker.warm = result.ok ? recordWarmSession(worker.warm, state.task.feature, usage.session, usage.tokens, d.config) : emptyWarmSession();
  if (result.ok) return ok(true);
  if (result.error.code === 'FINALIZATION_PERSIST_FAILED') return escalate(d, state.task, result.error.message, claimToken);
  if (result.error.code === 'REVIEW_CONFLICT' || result.error.code === 'REVIEW_STUCK') return ok(false);
  let reason = result.error.message;
  if (result.error.code !== 'MERGE_CONFLICT') {
    const abandoned = await d.git.abandonBranch(branch); if (!abandoned.ok) reason += `; abandonBranch: ${abandoned.error.message}`;
  }
  return escalate(d, state.task, reason, claimToken);
}
async function runWorker(d: Deps, shared: SharedState): Promise<Result<void>> {
  const worker = { warm: emptyWarmSession() };
  while (true) {
    const c = await claim(d);
    if (!c.ok) { await notify(d, undefined, `Queue error: ${c.error.code}`, c.error.message); return c; }
    if (!c.value) {
      const next = await waitForWork(d, shared); if (!next.ok || next.value === 'stop') return next.ok ? ok(undefined) : next;
      continue;
    }
    const handled = await handleClaim(d, c.value, worker); if (!handled.ok) return handled;
    if (handled.value) { const swept = await maybeSweep(d, shared); if (!swept.ok) return swept; }
  }
}

export async function runOrchestrator(deps: Deps): Promise<Result<void>> {
  if (!deps.config.codexEnabled) return err('CONFIG_ERROR', 'Parallel Opus + Codex review is required by ARCHITECTURE.md');
  const shared = { sweepCounter: 0 }, count = Math.max(1, deps.config.maxParallelAgents);
  const results = await Promise.all(Array.from({ length: count }, () => runWorker(deps, shared)));
  const failure = results.find(result => !result.ok);
  return failure ?? ok(undefined);
}
