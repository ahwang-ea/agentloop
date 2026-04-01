import { randomUUID } from 'node:crypto';
import { ok, type Result } from '../shared/result.js';
import type { ClaimedActionableTask, TaskDefinition } from '../types/index.js';
import { canFeatureTaskRun } from './feature.js';
import { activeTaskStatuses, isClaimExpired, type TaskClaim, type TaskRecord } from './task-queue-store.js';

const leaseMs = 5 * 60_000;
const dependenciesDone = (tasks: TaskRecord[], task: TaskDefinition) =>
  (task.dependsOn ?? []).every(id => tasks.some(record => record.task.id === id && record.status === 'done'));
const nextQueuedTask = (tasks: TaskRecord[]) =>
  tasks.find(record => record.status === 'queued' && dependenciesDone(tasks, record.task) && canFeatureTaskRun(tasks, record.task));
const countActiveClaims = (tasks: TaskRecord[]) =>
  tasks.filter(task => activeTaskStatuses.has(task.status) && task.claim && !isClaimExpired(task.claim)).length;
const hasClaimedIntegrate = (tasks: TaskRecord[]) =>
  tasks.some(task => task.task.type === 'integrate' && activeTaskStatuses.has(task.status) && task.claim && !isClaimExpired(task.claim));
const claimedTask = (task: TaskRecord, status: 'writing' | 'merging'): ClaimedActionableTask => ({
  state: { status, task: task.task, branch: task.branch, round: task.round, convergence: task.convergence },
  claimToken: task.claim!.token,
});
const persistClaim = async <T>(persist: () => Promise<Result<void>>, value: T) => {
  const saved = await persist();
  return saved.ok ? ok(value) : saved;
};

export const leaseTaskClaim = (token?: string): TaskClaim => ({
  token: token ?? randomUUID(),
  expiresAt: new Date(Date.now() + leaseMs).toISOString(),
});

export async function claimNextActionableTask(
  tasks: TaskRecord[],
  maxParallelAgents: number,
  persist: () => Promise<Result<void>>,
): Promise<Result<ClaimedActionableTask | null>> {
  const nextLease = leaseTaskClaim();
  const activeCount = countActiveClaims(tasks);
  const busyFinalizing = tasks.some(task => task.status === 'finalizing' && task.claim && !isClaimExpired(task.claim));
  const finalizing = busyFinalizing ? undefined : tasks.find(task => task.status === 'finalizing' && isClaimExpired(task.claim));
  if (finalizing) {
    finalizing.claim = nextLease;
    return persistClaim(persist, {
      state: { status: 'finalizing', task: finalizing.task, finalization: finalizing.finalization! },
      claimToken: nextLease.token,
    });
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
  const queued = nextQueuedTask(tasks);
  if (!queued || (queued.task.type === 'integrate' && activeCount > 0)) return ok(null);
  Object.assign(queued, { status: 'writing', claim: nextLease, startedAt: new Date().toISOString() });
  return persistClaim(persist, claimedTask(queued, 'writing'));
}
