import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, TaskDefinition, TaskInput, TaskState } from '../types/index.js';
import { clearStaleLock } from './stale-lock.js';
import { parseTaskRecords, type PersistedTaskRecord } from './task-queue-parse.js';

export type TaskRecord = PersistedTaskRecord;
export type TaskClaim = NonNullable<TaskRecord['claim']>;
export const activeTaskStatuses = new Set(['writing', 'verifying', 'reviewing', 'fixing', 'cleanup', 'merging']);
const defaultTaskFile = 'tasks.json';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const withTaskType = (task: TaskDefinition): TaskDefinition => ({ ...task, type: task.type ?? 'implement' });

export const taskQueuePathOf = (config: AgentloopConfig) =>
  isAbsolute(config.taskFilePath ?? defaultTaskFile)
    ? config.taskFilePath!
    : join(config.repoPath, config.taskFilePath ?? defaultTaskFile);

export const isClaimExpired = (claim?: TaskRecord['claim'], now = Date.now()) =>
  !claim || Date.parse(claim.expiresAt) <= now;

export const countByDedupePrefix = (tasks: TaskRecord[], prefix: string) =>
  tasks.filter(task => task.dedupeKey?.startsWith(prefix) && task.status !== 'done' && task.status !== 'stuck').length;

export const stripTaskRecord = ({ claim: _claim, dedupeKey: _dedupeKey, ...task }: TaskRecord): TaskState => ({
  ...task,
  task: withTaskType(task.task),
});

export function requireTaskClaim(tasks: TaskRecord[], taskId: string, token: string): Result<TaskRecord> {
  const task = tasks.find(record => record.task.id === taskId);
  return task && task.claim?.token === token && !isClaimExpired(task.claim)
    ? ok(task)
    : err('SESSION_ERROR', `Invalid or expired claim for ${taskId}`);
}

export function createQueuedTaskRecord(task: TaskInput, dedupeKey?: string): TaskRecord {
  return {
    task: { ...task, type: task.type ?? 'implement', id: randomUUID(), createdAt: new Date().toISOString() },
    dedupeKey,
    status: 'queued',
    round: 0,
    startedAt: new Date().toISOString(),
  };
}

export async function withTaskQueueLock<T>(path: string, run: () => Promise<Result<T>>): Promise<Result<T>> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const stale = await clearStaleLock(lock);
  if (!stale.ok) return stale;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return err('TRANSPORT_ERROR', `Cannot lock ${path}`);
      if (attempt === 99) return err('SESSION_ERROR', `Timed out waiting for queue lock ${lock}`);
      await sleep(50);
    }
  }
  try {
    return await run();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function loadTaskQueue(path: string): Promise<Result<TaskRecord[]>> {
  try {
    const parsed = parseTaskRecords(await readFile(path, 'utf-8'), path);
    return parsed.ok
      ? ok(parsed.value.map(record => ({ ...record, task: withTaskType(record.task) })))
      : err('QUEUE_CORRUPT', parsed.error.message);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? ok([]) : err('TRANSPORT_ERROR', `Cannot read queue ${path}`);
  }
}

export async function saveTaskQueue(path: string, tasks: TaskRecord[]): Promise<Result<void>> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(tasks, null, 2));
    await rename(temp, path);
    return ok(undefined);
  } catch {
    return err('TRANSPORT_ERROR', `Cannot write queue ${path}`);
  }
}
