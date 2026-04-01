import { ok, err, type Result } from '../shared/result.js';
import type { TaskState } from '../types/index.js';
import type { SharedState, Deps } from '../orchestrator.js';
import { preGenerateScaffold } from './scaffold.js';
import { scaffoldStageDir } from './scaffold-stage.js';

const active = new Set(['queued', 'writing', 'verifying', 'reviewing', 'fixing', 'cleanup', 'merging', 'finalizing']);
const almostReady = new Set(['reviewing', 'cleanup']);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const expired = (deadlineAt?: number) => deadlineAt != null && Date.now() >= deadlineAt;

const readySoon = (task: TaskState, tasks: TaskState[]) => task.status === 'queued' && task.task.type !== 'research' && task.task.type !== 'debug'
  && (task.task.dependsOn ?? []).length > 0 && (task.task.dependsOn ?? []).every(depId => tasks.some(item => item.task.id === depId && almostReady.has(item.status)));

async function stageTask(d: Deps, task: TaskState, shared: SharedState): Promise<void> {
  if (shared.scaffoldPlanning.has(task.task.id)) return;
  shared.scaffoldPlanning.add(task.task.id);
  try {
    const staged = await preGenerateScaffold(d.claude, task.task, scaffoldStageDir(d.config.repoPath, task.task.id));
    if (!staged.ok) console.error(staged.error.message);
  } finally { shared.scaffoldPlanning.delete(task.task.id); }
}

export async function runPlanningWorker(d: Deps, shared: SharedState, deadlineAt?: number): Promise<Result<void>> {
  while (true) {
    if (expired(deadlineAt)) return err('BUDGET_EXCEEDED', 'Benchmark wall-clock limit exceeded');
    const listed = await d.queue.list(); if (!listed.ok) return listed;
    const candidates = listed.value.filter(task => readySoon(task, listed.value));
    if (candidates.length > 0) await Promise.all(candidates.map(task => stageTask(d, task, shared)));
    if (!listed.value.some(task => active.has(task.status))) return ok(undefined);
    await sleep(250);
  }
}
