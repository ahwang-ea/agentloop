import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, TaskState } from '../types/index.js';

const day = 24 * 60 * 60 * 1000;
const taskFilePath = (config: AgentloopConfig) => config.taskFilePath?.startsWith('/') ? config.taskFilePath : join(config.repoPath, config.taskFilePath ?? 'tasks.json');
const archivePath = (config: AgentloopConfig) => join(config.repoPath, '.agentloop', 'archive.jsonl');
const msg = (error: unknown) => [(error as { stderr?: string }).stderr, (error as { stdout?: string }).stdout, error instanceof Error ? error.message : String(error)].filter(Boolean).join('\n');
const keepTask = (task: TaskState, cutoff: number) => !['done', 'stuck'].includes(task.status) || typeof task.completedAt !== 'string' || Date.parse(task.completedAt) >= cutoff;

export async function archiveOldTasks(config: AgentloopConfig, now = Date.now()): Promise<Result<void>> {
  const path = taskFilePath(config), cutoff = now - (30 * day);
  let tasks: Array<TaskState & Record<string, unknown>>;
  try { tasks = JSON.parse(await readFile(path, 'utf-8')) as Array<TaskState & Record<string, unknown>>; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? ok(undefined) : err('QUEUE_CORRUPT', `Malformed queue file ${path}`); }
  const archived = tasks.filter(task => !keepTask(task, cutoff));
  if (archived.length === 0) return ok(undefined);
  try {
    await mkdir(join(config.repoPath, '.agentloop'), { recursive: true });
    await appendFile(archivePath(config), `${archived.map(task => JSON.stringify({ archivedAt: new Date(now).toISOString(), task })).join('\n')}\n`, 'utf-8');
    await writeFile(path, JSON.stringify(tasks.filter(task => keepTask(task, cutoff)), null, 2));
    return ok(undefined);
  } catch (error) { return err('TRANSPORT_ERROR', msg(error)); }
}
