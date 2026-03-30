import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, ClaudeAdapter, FinalizationState, TaskDefinition, TaskQueueAdapter, TaskState } from '../types/index.js';
import { featureBranchName } from './feature.js';
import { metricsPath } from './metrics.js';
import { notificationStatePath, pruneNotificationKeys } from './notifier.js';
import { taskBranchName, withBranchPrefix, worktreePathForBranch, worktreeRootPath } from './worktree.js';

interface GcDeps { claude: ClaudeAdapter; queue: TaskQueueAdapter; config: AgentloopConfig; }
const exec = promisify(execFile), day = 24 * 60 * 60 * 1000;
const active = new Set(['writing', 'verifying', 'reviewing', 'fixing', 'cleanup', 'merging', 'finalizing']);
const taskFilePath = (config: AgentloopConfig) => config.taskFilePath?.startsWith('/') ? config.taskFilePath : join(config.repoPath, config.taskFilePath ?? 'tasks.json');
const archivePath = (config: AgentloopConfig) => join(config.repoPath, '.agentloop', 'archive.jsonl');
const msg = (e: unknown) => [(e as { stderr?: string }).stderr, (e as { stdout?: string }).stdout, e instanceof Error ? e.message : String(e)].filter(Boolean).join('\n');
const exists = async (path: string) => stat(path).then(() => true).catch(() => false);
const ignore = (text: string) => /ENOENT|not a working tree|No such file|not found|unknown revision|cannot remove|not fully merged/i.test(text);
const keepTask = (task: TaskState, cutoff: number) => !['done', 'stuck'].includes(task.status) || typeof task.completedAt !== 'string' || Date.parse(task.completedAt) >= cutoff;
const baseFor = (config: AgentloopConfig, task: TaskState) => task.finalization?.mergeInto ?? (task.task.feature ? withBranchPrefix(config, featureBranchName(task.task.feature)) : config.baseBranch);
const rel = (root: string, path: string) => relative(root, path).replace(/\\/g, '/');

async function runGit(config: AgentloopConfig, args: string[]): Promise<Result<void>> {
  try { await exec('git', args, { cwd: config.repoPath }); return ok(undefined); }
  catch (e) { const text = msg(e); return ignore(text) ? ok(undefined) : err('GIT_ERROR', text); }
}
async function record(label: string, work: () => Promise<Result<void>>) {
  const result = await work();
  if (!result.ok) console.error(`gc ${label}: ${result.error.message}`);
}
async function removeBranch(config: AgentloopConfig, branch: string): Promise<Result<void>> {
  const path = worktreePathForBranch(config, branch);
  const removed = await runGit(config, ['worktree', 'remove', '--force', path]);
  if (!removed.ok) return removed;
  await rm(path, { recursive: true, force: true });
  return runGit(config, ['branch', '-d', withBranchPrefix(config, branch)]);
}
async function baseDirs(root: string, current = root, found: string[] = []): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(current, entry.name);
    if (await exists(join(path, '.git'))) found.push(path);
    else await baseDirs(root, path, found);
  }
  return found;
}
async function pruneParents(root: string, current: string) {
  while (current.startsWith(root) && current !== root) {
    const entries = await readdir(current).catch(() => [] as string[]);
    if (entries.length > 0) return;
    await rm(current, { recursive: true, force: true });
    current = dirname(current);
  }
}

export async function archiveOldTasks(config: AgentloopConfig, now = Date.now()): Promise<Result<void>> {
  const path = taskFilePath(config), cutoff = now - (30 * day);
  let tasks: Array<TaskState & Record<string, unknown>>;
  try { tasks = JSON.parse(await readFile(path, 'utf-8')) as Array<TaskState & Record<string, unknown>>; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? ok(undefined) : err('QUEUE_CORRUPT', `Malformed queue file ${path}`); }
  const archived = tasks.filter(task => !keepTask(task, cutoff));
  if (archived.length === 0) return ok(undefined);
  await mkdir(join(config.repoPath, '.agentloop'), { recursive: true });
  await appendFile(archivePath(config), `${archived.map(task => JSON.stringify({ archivedAt: new Date(now).toISOString(), task })).join('\n')}\n`, 'utf-8');
  await writeFile(path, JSON.stringify(tasks.filter(task => keepTask(task, cutoff)), null, 2));
  return ok(undefined);
}
async function removeOrphanedBases(config: AgentloopConfig, queue: TaskQueueAdapter): Promise<Result<void>> {
  const tasks = await queue.list(); if (!tasks.ok) return tasks;
  const needed = new Set(tasks.value.filter(task => active.has(task.status)).map(task => baseFor(config, task)));
  const root = join(worktreeRootPath(config), basename(config.repoPath), '_base');
  for (const path of await baseDirs(root)) {
    if (needed.has(rel(root, path))) continue;
    const removed = await runGit(config, ['worktree', 'remove', '--force', path]);
    if (!removed.ok) return removed;
    await rm(path, { recursive: true, force: true });
    await pruneParents(root, dirname(path));
  }
  return ok(undefined);
}
async function rotateMetrics(config: AgentloopConfig, now = Date.now()): Promise<Result<void>> {
  const path = metricsPath(config); let info;
  try { info = await stat(path); } catch { return ok(undefined); }
  if (now - info.mtimeMs < 90 * day) return ok(undefined);
  const dir = join(config.repoPath, '.agentloop', 'metrics-archive');
  const base = `metrics-${new Date(info.mtimeMs).toISOString().slice(0, 10)}`;
  let archive = join(dir, `${base}.jsonl`), suffix = 1;
  while (await exists(archive)) archive = join(dir, `${base}-${suffix++}.jsonl`);
  await mkdir(dir, { recursive: true });
  await rename(path, archive);
  await writeFile(path, '', 'utf-8');
  return ok(undefined);
}
async function cleanupFiles(config: AgentloopConfig, now = Date.now()): Promise<Result<void>> {
  const notifications = notificationStatePath(config), tasks = taskFilePath(config), temp = new RegExp(`^${basename(tasks).replace('.', '\\.')}\\..+\\.tmp$`);
  for (const dir of [dirname(notifications), dirname(tasks)]) for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name), age = await stat(path).then(info => now - info.mtimeMs).catch(() => 0);
    if (entry.isDirectory() && entry.name.endsWith('.lock') && age > 5 * 60 * 1000) await rm(path, { recursive: true, force: true });
    if (entry.isFile() && (entry.name === 'notifications.json.tmp' || temp.test(entry.name))) await rm(path, { force: true });
  }
  const agents = await exists(join(config.repoPath, config.agentsMdPath));
  const architecture = config.architectureMdPath ? await exists(join(config.repoPath, config.architectureMdPath)) : true;
  if (agents && architecture) {
    await rm(join(config.repoPath, '.agentloop', 'drafts'), { recursive: true, force: true });
    await rm(join(config.repoPath, '.agentloop', 'init-questions.json'), { force: true });
    await rm(join(config.repoPath, '.agentloop', 'coverage.json'), { force: true });
  }
  return ok(undefined);
}
async function archiveResearch(config: AgentloopConfig, task: TaskDefinition, fin: FinalizationState): Promise<Result<void>> {
  if (!task.feature || !fin.featureMerged) return ok(undefined);
  const feature = task.feature.toLowerCase().replace(/[^a-z0-9]+/g, ''), dir = join(config.repoPath, '.agentloop', 'research');
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []), archive = join(config.repoPath, '.agentloop', 'archive');
  await mkdir(archive, { recursive: true });
  for (const entry of entries.filter(item => item.isFile() && item.name.endsWith('.md'))) {
    if (!entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '').includes(feature)) continue;
    await rename(join(dir, entry.name), join(archive, entry.name)).catch(() => rm(join(dir, entry.name), { force: true }));
  }
  return ok(undefined);
}

export async function gc(d: GcDeps, task: TaskDefinition, fin: FinalizationState): Promise<Result<void>> {
  await record('task branch', () => removeBranch(d.config, fin.branch));
  const taskBranch = withBranchPrefix(d.config, taskBranchName(task));
  if (fin.featureMerged && fin.branch !== taskBranch) await record('source branch', () => removeBranch(d.config, taskBranch));
  await record('base worktrees', () => removeOrphanedBases(d.config, d.queue));
  await record('notifications', () => pruneNotificationKeys(d.config));
  await record('task archive', () => archiveOldTasks(d.config));
  await record('metrics', () => rotateMetrics(d.config));
  await record('temp files', () => cleanupFiles(d.config));
  await record('research archive', () => archiveResearch(d.config, task, fin));
  await record('claude sessions', () => d.claude.evictTaskSessions(task.id));
  return ok(undefined);
}
