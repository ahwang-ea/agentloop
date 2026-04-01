import type { ClaimedActionableTask, TaskDefinition } from '../types/index.js';
import { ok, err, type Result } from '../shared/result.js';
import type { Deps } from '../orchestrator.js';
import { verifyCodexCli } from './codex-writer.js';
import { finalize } from './finalizer.js';
import { featureBranchName } from './feature.js';
import { refreshLearnings } from './learnings.js';
import { logTaskMetrics } from './metrics.js';
import { runResearchTask } from './research-task.js';
import { emptyWarmSession, newTaskUsage, pickWarmSession, recordWarmSession, type WarmSessionState } from './session-budget.js';
import { mergeCommittedBranch } from './task-merge.js';
import { runTask } from './task-runner.js';
import { taskBranchName, worktreePathForBranch } from './worktree.js';

export interface WorkerState { warm: WarmSessionState; }

const MAX_FINALIZE_RETRIES = 3;
const learn = async (d: Pick<Deps, 'config' | 'claude' | 'notifier'>) => {
  const result = await refreshLearnings(d.config, d.claude, d.notifier);
  if (!result.ok) console.error(result.error.message);
};

export const createWorkerState = (): WorkerState => ({ warm: emptyWarmSession() });

export async function notify(d: Deps, taskId: string | undefined, summary: string, details: string,
  type: 'escalation' | 'behavior-change' | 'sweep-result' | 'promotion-ready' = 'escalation', idempotencyKey?: string): Promise<Result<void>> {
  const result = await d.notifier.send({ type, taskId, summary, details, timestamp: new Date().toISOString(), idempotencyKey });
  return result.ok ? ok(undefined) : err('NOTIFY_FAILED', result.error.message);
}

export async function recordStuck(d: Deps, task: TaskDefinition, reason: string): Promise<void> {
  const logged = await logTaskMetrics(d.config, d.queue, task, 'stuck');
  if (!logged.ok) console.error(logged.error.message); else await learn(d);
  const notice = await notify(d, task.id, `Stuck: ${task.title}`, reason);
  if (!notice.ok) console.error(notice.error.message);
}

async function escalate(d: Deps, task: TaskDefinition, reason: string, token: string): Promise<Result<boolean>> {
  const stuck = await d.queue.markStuck(task.id, reason, token);
  if (!stuck.ok) return err(stuck.error.code, `markStuck: ${stuck.error.message}`);
  await recordStuck(d, task, reason);
  return ok(false);
}

async function blockDebugTask(d: Deps, task: TaskDefinition, token: string): Promise<Result<boolean>> {
  const blocked = await d.queue.markBlocked(task.id, 'debug tasks need human intervention', { kind: 'needs-human', command: `agentloop approve ${task.id}` }, token);
  if (!blocked.ok) return blocked;
  const logged = await logTaskMetrics(d.config, d.queue, task, 'needs-human');
  if (!logged.ok) console.error(logged.error.message); else await learn(d);
  const notice = await notify(d, task.id, `Needs human: ${task.title}`, 'Debug tasks are escalated immediately.');
  if (!notice.ok) console.error(notice.error.message);
  return ok(false);
}

export async function handleClaim(d: Deps, claimed: ClaimedActionableTask, worker: WorkerState): Promise<Result<boolean>> {
  const { state, claimToken } = claimed;
  if (state.status === 'finalizing') {
    const done = await finalize(d, state.task, state.finalization, claimToken);
    if (done.ok) return ok(false);
    const updated = { ...state.finalization, failCount: state.finalization.failCount + 1 };
    const saved = await d.queue.updateFinalization(state.task.id, updated, claimToken);
    if (!saved.ok) return saved;
    if (updated.failCount >= MAX_FINALIZE_RETRIES) return escalate(d, state.task, `Finalization failed ${MAX_FINALIZE_RETRIES}x: ${done.error.message}`, claimToken);
    const released = await d.queue.releaseClaim(state.task.id, claimToken);
    return released.ok ? ok(false) : released;
  }
  if (state.task.type === 'debug') return blockDebugTask(d, state.task, claimToken);
  const useCodexWriter = d.config.useCodexWriter ?? true;
  if (state.task.type !== 'research') {
    if (!d.config.codexEnabled) return escalate(d, state.task, 'Codex + Opus review requires OPENAI_API_KEY', claimToken);
    if (useCodexWriter) {
      const codex = await verifyCodexCli();
      if (!codex.ok) return escalate(d, state.task, codex.error.message, claimToken);
    }
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
  if (state.status === 'merging') return mergeCommittedBranch(d.git, d.queue, state.task, branch, base, claimToken).then(result => result.ok ? ok(true) : result);
  if (state.task.type === 'research') return runResearchTask(d, state.task, branch, worktreePath, claimToken).then(result => result.ok ? ok(false) : result);
  const usage = newTaskUsage(), warm = state.task.type === 'integrate' ? undefined : pickWarmSession(worker.warm, state.task.feature);
  const taskDeps = { ...d, config: { ...d.config, useCodexWriter } };
  const result = await runTask(taskDeps, state.task, branch, base, worktreePath, state.convergence, claimToken, warm, usage, !state.branch);
  worker.warm = result.ok && state.task.type === 'implement'
    ? recordWarmSession(worker.warm, state.task.feature, usage.session, usage.tokens, d.config)
    : emptyWarmSession();
  if (result.ok) return ok(true);
  if (result.error.code === 'FINALIZATION_PERSIST_FAILED') return escalate(d, state.task, result.error.message, claimToken);
  if (result.error.code === 'REVIEW_CONFLICT' || result.error.code === 'REVIEW_STUCK') return ok(false);
  let reason = result.error.message;
  if (result.error.code !== 'MERGE_CONFLICT') {
    const abandoned = await d.git.abandonBranch(branch);
    if (!abandoned.ok) reason += `; abandonBranch: ${abandoned.error.message}`;
  }
  return escalate(d, state.task, reason, claimToken);
}
