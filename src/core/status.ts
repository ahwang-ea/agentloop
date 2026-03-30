import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, TaskState } from '../types/index.js';

const active = new Set(['writing', 'verifying', 'reviewing', 'fixing', 'cleanup', 'merging', 'finalizing']);
const taskFilePath = (config: AgentloopConfig) =>
  isAbsolute(config.taskFilePath ?? 'tasks.json') ? config.taskFilePath! : join(config.repoPath, config.taskFilePath ?? 'tasks.json');

export interface StatusSummary {
  queued: number;
  active: number;
  done: number;
  stuck: number;
  blocked: number;
  blockedTasks: Array<{ id: string; title: string; reason: string }>;
  stuckTasks: Array<{ title: string; reason: string }>;
}

export async function readStatusSummary(config: AgentloopConfig): Promise<Result<StatusSummary>> {
  const path = taskFilePath(config);
  let tasks: TaskState[];
  try { tasks = JSON.parse(await readFile(path, 'utf-8')) as TaskState[]; }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return ok({ queued: 0, active: 0, done: 0, stuck: 0, blocked: 0, blockedTasks: [], stuckTasks: [] });
    if (e instanceof SyntaxError) return err('QUEUE_CORRUPT', `Malformed queue file ${path}`);
    return err('TRANSPORT_ERROR', `Cannot read queue ${path}`);
  }
  const stuckTasks = tasks.filter(task => task.status === 'stuck')
    .map(task => ({ title: task.task.title, reason: task.stuckReason ?? 'No reason recorded' }));
  const blockedTasks = tasks.filter(task => task.status === 'blocked')
    .map(task => ({ id: task.task.id, title: task.task.title, reason: task.blocked?.reason ?? 'Blocked' }));
  return ok({
    queued: tasks.filter(task => task.status === 'queued').length,
    active: tasks.filter(task => active.has(task.status)).length,
    done: tasks.filter(task => task.status === 'done').length,
    stuck: stuckTasks.length,
    blocked: blockedTasks.length,
    blockedTasks,
    stuckTasks,
  });
}

export const formatStatusSummary = (summary: StatusSummary) => [
  `Queued: ${summary.queued}`,
  `Active: ${summary.active}`,
  `Done: ${summary.done}`,
  `Stuck: ${summary.stuck}`,
  `Blocked: ${summary.blocked}`,
  ...(summary.blockedTasks.length === 0 ? [] : ['Blocked tasks:', ...summary.blockedTasks.map(task => `- ${task.id}: ${task.title} — ${task.reason}`)]),
  ...(summary.stuckTasks.length === 0 ? [] : ['Stuck tasks:', ...summary.stuckTasks.map(task => `- ${task.title}: ${task.reason}`)]),
].join('\n');
