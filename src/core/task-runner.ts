import type { ClaudeSession, ConvergenceState, TaskDefinition } from '../types/index.js';
import type { Deps } from '../orchestrator.js';
import { err, type Result } from '../shared/result.js';
import type { TaskUsage } from './session-budget.js';
import { finishTaskRun } from './task-runner-finish.js';
import { runTaskSetup, type TaskRunContext } from './task-runner-setup.js';

export async function runTask(
  d: Deps, task: TaskDefinition, branch: string, mergeInto: string, worktreePath: string,
  seed: ConvergenceState | undefined, token: string, warmSession: ClaudeSession | undefined, usage: TaskUsage, shouldScaffold: boolean,
): Promise<Result<void>> {
  const ctx: TaskRunContext = { d, task, branch, mergeInto, worktreePath, token, usage };
  const setup = await runTaskSetup(ctx, seed, warmSession, shouldScaffold);
  return setup.ok ? finishTaskRun(ctx, setup.value) : err(setup.error.code, setup.error.message, setup.error.details);
}
