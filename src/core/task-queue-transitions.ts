import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from '../shared/result.js';
import type { ClaimedActionableTask, FinalizationState, TaskDefinition, TaskStatus } from '../types/index.js';
import { canFeatureTaskRun } from './feature.js';
import { activeTaskStatuses, isClaimExpired, requireTaskClaim, type TaskClaim, type TaskRecord } from './task-queue-store.js';

const LEASE_MS = 5 * 60_000;
const lease = (token?: string): TaskClaim => ({ token: token ?? randomUUID(), expiresAt: new Date(Date.now() + LEASE_MS).toISOString() });
const depsDone = (tasks: TaskRecord[], task: TaskDefinition) =>
  (task.dependsOn ?? []).every(id => tasks.some(record => record.task.id === id && record.status === 'done'));
const nextQueued = (tasks: TaskRecord[]) =>
  tasks.find(record => record.status === 'queued' && depsDone(tasks, record.task) && canFeatureTaskRun(tasks, record.task));
const countActiveClaims = (tasks: TaskRecord[]) =>
  tasks.filter(task => activeTaskStatuses.has(task.status) && task.claim && !isClaimExpired(task.claim)).length;
const hasClaimedIntegrate = (tasks: TaskRecord[]) =>
  tasks.some(task => task.task.type === 'integrate' && activeTaskStatuses.has(task.status) && task.claim && !isClaimExpired(task.claim));
const setClaim = (task: TaskRecord, claimToken: string) => { task.claim = lease(claimToken); };
const persistClaim = async <T>(persist: () => Promise<Result<void>>, value: T) => {
  const saved = await persist();
  return saved.ok ? ok(value) : saved;
};
const claimedTask = (task: TaskRecord, status: 'writing' | 'merging'): ClaimedActionableTask => ({
  state: { status, task: task.task, branch: task.branch, round: task.round, convergence: task.convergence },
  claimToken: task.claim!.token,
});
const mutateClaimedTask = (
  tasks: TaskRecord[],
  taskId: string,
  claimToken: string,
  mutate: (task: TaskRecord) => void,
): Result<void> => {
  const task = requireTaskClaim(tasks, taskId, claimToken);
  if (!task.ok) return task;
  mutate(task.value);
  return ok(undefined);
};
const completeTask = (task: TaskRecord, status: 'done' | 'stuck', extra: Partial<TaskRecord> = {}) => {
  Object.assign(task, { status, completedAt: new Date().toISOString(), claim: undefined }, extra);
};

export async function claimNextActionableTask(
  tasks: TaskRecord[],
  maxParallelAgents: number,
  persist: () => Promise<Result<void>>,
): Promise<Result<ClaimedActionableTask | null>> {
  const nextLease = lease(), activeCount = countActiveClaims(tasks);
  const busyFinalizing = tasks.some(task => task.status === 'finalizing' && task.claim && !isClaimExpired(task.claim));
  const finalizing = busyFinalizing ? undefined : tasks.find(task => task.status === 'finalizing' && isClaimExpired(task.claim));
  if (finalizing) {
    finalizing.claim = nextLease;
    return persistClaim(persist, { state: { status: 'finalizing', task: finalizing.task, finalization: finalizing.finalization! }, claimToken: nextLease.token });
  }
  if (hasClaimedIntegrate(tasks) || activeCount >= maxParallelAgents) return ok(null);
  const resumable = tasks.find(task => activeTaskStatuses.has(task.status) && isClaimExpired(task.claim));
  if (resumable) {
    if (resumable.task.type === 'integrate' && activeCount > 0) return ok(null);
    const status = resumable.status === 'merging' ? 'merging' : 'writing';
    resumable.status = status;
    resumable.claim = nextLease;
    return persistClaim(persist, claimedTask(resumable, status));
  }
  const queued = nextQueued(tasks);
  if (!queued || (queued.task.type === 'integrate' && activeCount > 0)) return ok(null);
  queued.status = 'writing';
  queued.claim = nextLease;
  queued.startedAt = new Date().toISOString();
  return persistClaim(persist, claimedTask(queued, 'writing'));
}

export const renewTaskClaim = (tasks: TaskRecord[], taskId: string, claimToken: string) =>
  mutateClaimedTask(tasks, taskId, claimToken, task => setClaim(task, claimToken));
export const updateTaskStatus = (tasks: TaskRecord[], taskId: string, status: TaskStatus, claimToken: string) =>
  mutateClaimedTask(tasks, taskId, claimToken, task => {
    task.status = status;
    setClaim(task, claimToken);
  });
export const updateTaskProgress = (
  tasks: TaskRecord[],
  taskId: string,
  progress: Pick<TaskRecord, 'branch' | 'round' | 'convergence'>,
  claimToken: string,
) => mutateClaimedTask(tasks, taskId, claimToken, task => Object.assign(task, progress, { claim: lease(claimToken) }));
export const beginTaskFinalization = (
  tasks: TaskRecord[],
  taskId: string,
  finalization: FinalizationState,
  claimToken: string,
) => mutateClaimedTask(tasks, taskId, claimToken, task => Object.assign(task, { status: 'finalizing', finalization, claim: undefined }));
export const updateTaskFinalization = (
  tasks: TaskRecord[],
  taskId: string,
  finalization: FinalizationState,
  claimToken: string,
) => mutateClaimedTask(tasks, taskId, claimToken, task => {
  task.finalization = finalization;
  setClaim(task, claimToken);
});
export const markTaskDone = (tasks: TaskRecord[], taskId: string, claimToken: string) =>
  mutateClaimedTask(tasks, taskId, claimToken, task => completeTask(task, 'done'));
export const markTaskStuck = (tasks: TaskRecord[], taskId: string, reason: string, claimToken: string) =>
  mutateClaimedTask(tasks, taskId, claimToken, task => completeTask(task, 'stuck', { stuckReason: reason }));
export function markQueuedTaskStuck(tasks: TaskRecord[], taskId: string, reason: string): Result<void> {
  const task = tasks.find(record => record.task.id === taskId);
  if (!task) return err('QUEUE_EMPTY', `Task not found: ${taskId}`);
  if (task.status !== 'queued') return err('CONFIG_ERROR', `Task ${taskId} is not queued`);
  completeTask(task, 'stuck', { stuckReason: reason });
  return ok(undefined);
}
export const markTaskBlocked = (
  tasks: TaskRecord[],
  taskId: string,
  reason: string,
  details: Record<string, unknown>,
  claimToken: string,
) => mutateClaimedTask(tasks, taskId, claimToken, task => {
  Object.assign(task, {
    status: 'blocked',
    completedAt: new Date().toISOString(),
    blocked: { reason, details, blockedAt: new Date().toISOString() },
    claim: undefined,
  });
});
export function requeueBlockedTask(tasks: TaskRecord[], taskId: string): Result<void> {
  const task = tasks.find(record => record.task.id === taskId);
  if (!task) return err('QUEUE_EMPTY', `Task not found: ${taskId}`);
  Object.assign(task, { status: 'queued', blocked: undefined, round: 0, convergence: undefined, completedAt: undefined, claim: undefined });
  return ok(undefined);
}
export function approveBlockedTask(tasks: TaskRecord[], taskId: string): Result<void> {
  const task = tasks.find(record => record.task.id === taskId && record.status === 'blocked');
  if (!task) return err('QUEUE_EMPTY', `Blocked task not found: ${taskId}`);
  if (task.finalization) {
    Object.assign(task, {
      status: 'finalizing',
      blocked: undefined,
      completedAt: undefined,
      claim: undefined,
      finalization: { ...task.finalization, approved: true },
    });
    return ok(undefined);
  }
  if (task.blocked?.details.kind === 'research-approval') {
    Object.assign(task, { status: 'merging', blocked: undefined, completedAt: undefined, claim: undefined });
    return ok(undefined);
  }
  Object.assign(task, { status: 'queued', blocked: undefined, round: 0, convergence: undefined, completedAt: undefined, claim: undefined });
  return ok(undefined);
}
export const releaseTaskClaim = (tasks: TaskRecord[], taskId: string, claimToken: string) =>
  mutateClaimedTask(tasks, taskId, claimToken, task => { task.claim = undefined; });
