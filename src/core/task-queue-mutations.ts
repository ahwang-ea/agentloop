import { err, ok, type Result } from '../shared/result.js';
import type { FinalizationState, TaskStatus } from '../types/index.js';
import { requireTaskClaim, type TaskRecord } from './task-queue-store.js';
import { leaseTaskClaim } from './task-queue-claim.js';

const setClaim = (task: TaskRecord, claimToken: string) => { task.claim = leaseTaskClaim(claimToken); };
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
const resetToQueued = (task: TaskRecord) => {
  Object.assign(task, { status: 'queued', blocked: undefined, round: 0, convergence: undefined, completedAt: undefined, claim: undefined });
};

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
) => mutateClaimedTask(tasks, taskId, claimToken, task => Object.assign(task, progress, { claim: leaseTaskClaim(claimToken) }));
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
  if (task.status !== 'blocked') return err('CONFIG_ERROR', `Task ${taskId} is not blocked`);
  resetToQueued(task);
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
  resetToQueued(task);
  return ok(undefined);
}

export const releaseTaskClaim = (tasks: TaskRecord[], taskId: string, claimToken: string) =>
  mutateClaimedTask(tasks, taskId, claimToken, task => { task.claim = undefined; });
