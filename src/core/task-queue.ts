// core/task-queue.ts — File-backed task queue adapter with leases.

import { ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, TaskInput, TaskQueueAdapter } from '../types/index.js';
import { normalizeTaskForRepo } from './monorepo.js';
import {
  approveBlockedTask,
  beginTaskFinalization,
  claimNextActionableTask,
  markQueuedTaskStuck,
  markTaskBlocked,
  markTaskDone,
  markTaskStuck,
  releaseTaskClaim,
  requeueBlockedTask,
  renewTaskClaim,
  updateTaskFinalization,
  updateTaskProgress,
  updateTaskStatus,
} from './task-queue-transitions.js';
import {
  countByDedupePrefix,
  createQueuedTaskRecord,
  loadTaskQueue,
  saveTaskQueue,
  stripTaskRecord,
  taskQueuePathOf,
  type TaskQueueFile,
  type TaskRecord,
  withTaskQueueLock,
} from './task-queue-store.js';

export function createFileTaskQueue(config: AgentloopConfig): TaskQueueAdapter {
  const path = taskQueuePathOf(config);
  const withRecords = <T>(run: (queue: TaskQueueFile) => Promise<Result<T>>) => withTaskQueueLock(path, async () => {
    const queue = await loadTaskQueue(path);
    return queue.ok ? run(queue.value) : queue;
  });
  const mutateRecords = (apply: (tasks: TaskRecord[]) => Result<void>) => withRecords(async queue => {
    const updated = apply(queue.tasks);
    return updated.ok ? saveTaskQueue(path, queue) : updated;
  });
  const addRecord = async (queue: TaskQueueFile, task: TaskInput, dedupeKey?: string): Promise<Result<TaskRecord['task']>> => {
    const record = createQueuedTaskRecord(task, dedupeKey);
    queue.tasks.push(record);
    const saved = await saveTaskQueue(path, queue);
    return saved.ok ? ok(record.task) : saved;
  };

  return {
    async claimNextActionable(maxParallelAgents) {
      return withRecords(queue => claimNextActionableTask(queue.tasks, maxParallelAgents, () => saveTaskQueue(path, queue)));
    },
    async renewClaim(taskId, claimToken) { return mutateRecords(tasks => renewTaskClaim(tasks, taskId, claimToken)); },
    async updateStatus(taskId, status, claimToken) { return mutateRecords(tasks => updateTaskStatus(tasks, taskId, status, claimToken)); },
    async updateProgress(taskId, progress, claimToken) { return mutateRecords(tasks => updateTaskProgress(tasks, taskId, progress, claimToken)); },
    async beginFinalization(taskId, finalization, claimToken) { return mutateRecords(tasks => beginTaskFinalization(tasks, taskId, finalization, claimToken)); },
    async updateFinalization(taskId, finalization, claimToken) { return mutateRecords(tasks => updateTaskFinalization(tasks, taskId, finalization, claimToken)); },
    async markDone(taskId, claimToken) { return mutateRecords(tasks => markTaskDone(tasks, taskId, claimToken)); },
    async markStuck(taskId, reason, claimToken) { return mutateRecords(tasks => markTaskStuck(tasks, taskId, reason, claimToken)); },
    async markQueuedStuck(taskId, reason) { return mutateRecords(tasks => markQueuedTaskStuck(tasks, taskId, reason)); },
    async markBlocked(taskId, reason, details, claimToken) { return mutateRecords(tasks => markTaskBlocked(tasks, taskId, reason, details, claimToken)); },
    async requeueBlocked(taskId) { return mutateRecords(tasks => requeueBlockedTask(tasks, taskId)); },
    async approveBlocked(taskId) { return mutateRecords(tasks => approveBlockedTask(tasks, taskId)); },
    async releaseClaim(taskId, claimToken) { return mutateRecords(tasks => releaseTaskClaim(tasks, taskId, claimToken)); },
    async add(task) {
      const normalized = await normalizeTaskForRepo(config.repoPath, task);
      return normalized.ok ? withRecords(queue => addRecord(queue, normalized.value)) : normalized;
    },
    async ensureTask(dedupeKey, task) {
      const normalized = await normalizeTaskForRepo(config.repoPath, task);
      if (!normalized.ok) return normalized;
      return withRecords(async queue => {
        const existing = queue.tasks.find(record => record.dedupeKey === dedupeKey);
        return existing ? ok(existing.task) : addRecord(queue, normalized.value, dedupeKey);
      });
    },
    async countByDedupePrefix(prefix) { return withRecords(async queue => ok(countByDedupePrefix(queue.tasks, prefix))); },
    async list() {
      const queue = await loadTaskQueue(path);
      return queue.ok ? ok(queue.value.tasks.map(stripTaskRecord)) : queue;
    },
  };
}
