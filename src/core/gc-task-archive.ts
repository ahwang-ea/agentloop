import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig } from '../types/index.js';
import { loadTaskQueue, saveTaskQueue, taskQueuePathOf, type TaskRecord } from './task-queue-store.js';

const day = 24 * 60 * 60 * 1000;
const archivePath = (config: AgentloopConfig) => join(config.repoPath, '.agentloop', 'archive.jsonl');
const msg = (error: unknown) => [(error as { stderr?: string }).stderr, (error as { stdout?: string }).stdout, error instanceof Error ? error.message : String(error)].filter(Boolean).join('\n');
const keepTask = (task: TaskRecord, cutoff: number) => !['done', 'stuck'].includes(task.status) || typeof task.completedAt !== 'string' || Date.parse(task.completedAt) >= cutoff;

export async function archiveOldTasks(config: AgentloopConfig, now = Date.now()): Promise<Result<void>> {
  const path = taskQueuePathOf(config), cutoff = now - (30 * day), queue = await loadTaskQueue(path);
  if (!queue.ok) return queue;
  const archived = queue.value.tasks.filter(task => !keepTask(task, cutoff));
  if (archived.length === 0) return ok(undefined);
  try {
    await mkdir(join(config.repoPath, '.agentloop'), { recursive: true });
    await appendFile(archivePath(config), `${archived.map(task => JSON.stringify({ archivedAt: new Date(now).toISOString(), task })).join('\n')}\n`, 'utf-8');
  } catch (error) { return err('TRANSPORT_ERROR', msg(error)); }
  queue.value.tasks = queue.value.tasks.filter(task => keepTask(task, cutoff));
  return saveTaskQueue(path, queue.value);
}
