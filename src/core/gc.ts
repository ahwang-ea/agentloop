import { ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, ClaudeAdapter, FinalizationState, TaskDefinition, TaskQueueAdapter } from '../types/index.js';
import { archiveResearch, cleanupFiles, rotateMetrics } from './gc-artifacts.js';
import { archiveOldTasks } from './gc-task-archive.js';
import { pruneGcArchives } from './gc-retention.js';
import { removeBranch, removeOrphanedBases, removeStaleShotgunWorktrees } from './gc-worktrees.js';
import { pruneNotificationKeys } from './notifier.js';
import { cleanupStaleScaffolds } from './scaffold-stage.js';
import { taskBranchName, withBranchPrefix } from './worktree.js';

interface GcDeps { claude: ClaudeAdapter; queue: TaskQueueAdapter; config: AgentloopConfig; }

const msg = (error: unknown) => [(error as { stderr?: string }).stderr, (error as { stdout?: string }).stdout, error instanceof Error ? error.message : String(error)].filter(Boolean).join('\n');

async function record(label: string, work: () => Promise<Result<void>>) {
  try {
    const result = await work();
    if (!result.ok) console.error(`gc ${label}: ${result.error.message}`);
  } catch (error) { console.error(`gc ${label}: ${msg(error)}`); }
}

export { archiveOldTasks };

export async function gc(d: GcDeps, task: TaskDefinition, fin: FinalizationState): Promise<Result<void>> {
  await record('task branch', () => removeBranch(d.config, fin.branch));
  const taskBranch = withBranchPrefix(d.config, taskBranchName(task));
  if (fin.featureMerged && fin.branch !== taskBranch) await record('source branch', () => removeBranch(d.config, taskBranch));
  await record('base worktrees', () => removeOrphanedBases(d.config, d.queue));
  await record('shotgun worktrees', () => removeStaleShotgunWorktrees(d.config, d.queue));
  await record('notifications', () => pruneNotificationKeys(d.config));
  await record('task archive', () => archiveOldTasks(d.config));
  await record('metrics', () => rotateMetrics(d.config));
  await record('archives', () => pruneGcArchives(d.config));
  await record('staged scaffolds', () => cleanupStaleScaffolds(d.config));
  await record('temp files', () => cleanupFiles(d.config));
  await record('research archive', () => archiveResearch(d.config, task, fin));
  await record('claude sessions', () => d.claude.evictTaskSessions(task.id));
  return ok(undefined);
}
