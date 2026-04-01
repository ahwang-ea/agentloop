import type { ClaudeSession, ConvergenceState, TaskDefinition } from '../types/index.js';
import type { Deps } from '../orchestrator.js';
import { ok, err, type Result } from '../shared/result.js';
import { recordErrorType, recordSessionChanges } from './metrics.js';
import { addTaskTokens, type TaskUsage } from './session-budget.js';
import { withLease } from './lease.js';
import { reviewPhase } from './review-loop.js';
import { scaffoldTask } from './scaffold.js';
import { writeCurrentScope } from './scope-file.js';
import { verifyLoop } from './verify-loop.js';
import { startWrite, type StartedWrite } from './writer.js';
import { concreteTargetsOf } from './writer-prompt.js';

export interface TaskRunContext {
  d: Deps;
  task: TaskDefinition;
  branch: string;
  mergeInto: string;
  worktreePath: string;
  token: string;
  usage: TaskUsage;
}

export interface TaskRunState {
  conv: ConvergenceState;
  started: StartedWrite;
  t0: number;
}

const shouldLogWrite = () => process.env.AGENTLOOP_LOG_WRITE === '1' || process.env.AGENTLOOP_LOG_VERIFY === '1';
const retryableStart = (code: string, message: string) => code === 'SESSION_ERROR' || code === 'BUDGET_EXCEEDED' || /timed out|api error|overloaded|temporarily unavailable/i.test(message);
const newConvergence = (): ConvergenceState => ({ rounds: [], classification: 'unknown' as const, webSearchTriggered: false, reviewFindings: 0, errorTypes: [], changedFiles: [] });
const saveProgress = (ctx: TaskRunContext, conv: ConvergenceState, branch?: string) => ctx.d.queue.updateProgress(
  ctx.task.id,
  branch === undefined ? { round: conv.rounds.length, convergence: conv } : { branch, round: conv.rounds.length, convergence: conv },
  ctx.token,
);

async function scaffoldFiles(ctx: TaskRunContext, conv: ConvergenceState, shouldScaffold: boolean): Promise<Result<string[]>> {
  const scaffold = shouldScaffold
    ? await withLease(() => scaffoldTask(ctx.d.claude, ctx.task, ctx.worktreePath), () => ctx.d.queue.renewClaim(ctx.task.id, ctx.token))
    : ok<string[]>([]);
  if (scaffold.ok) return scaffold;
  recordErrorType(conv, `scaffold ${scaffold.error.message}`);
  console.error(`Scaffold skipped: ${scaffold.error.message}`);
  const progress = await saveProgress(ctx, conv, ctx.branch);
  return progress.ok ? ok([]) : err(progress.error.code, progress.error.message, progress.error.details);
}

async function startInitialWrite(
  ctx: TaskRunContext, conv: ConvergenceState, warmSession: ClaudeSession | undefined, scaffolded: string[],
): Promise<Result<{ started: StartedWrite; files: string[] }>> {
  const writeScope = await writeCurrentScope(ctx.worktreePath, ctx.task, 'write');
  if (!writeScope.ok) return err(writeScope.error.code, writeScope.error.message, writeScope.error.details);
  let started = await withLease(() => startWrite(ctx.d, ctx.task, ctx.worktreePath, warmSession), () => ctx.d.queue.renewClaim(ctx.task.id, ctx.token));
  if (!started.ok && retryableStart(started.error.code, started.error.message)) {
    if (shouldLogWrite()) console.error(`[write] ${ctx.task.id} retrying initial write after ${started.error.code}: ${started.error.message}`);
    const reset = await ctx.d.git.revertFiles(concreteTargetsOf(ctx.task), ctx.worktreePath);
    if (!reset.ok) return err(reset.error.code, reset.error.message, reset.error.details);
    started = await withLease(() => startWrite(ctx.d, ctx.task, ctx.worktreePath), () => ctx.d.queue.renewClaim(ctx.task.id, ctx.token));
  }
  if (!started.ok) return err(started.error.code, started.error.message);
  ctx.usage.session = started.value.session;
  addTaskTokens(ctx.usage, started.value.output.tokenEstimate);
  const files = [...new Set([...scaffolded, ...started.value.output.changedFiles])];
  if (files.length === 0) return err('EMPTY_RESPONSE', 'Writer changed no files during initial task execution');
  recordSessionChanges(conv, files);
  const progress = await saveProgress(ctx, conv);
  return progress.ok ? ok({ started: started.value, files }) : err(progress.error.code, progress.error.message, progress.error.details);
}

export async function runTaskSetup(
  ctx: TaskRunContext, seed: ConvergenceState | undefined, warmSession: ClaudeSession | undefined, shouldScaffold: boolean,
): Promise<Result<TaskRunState>> {
  const conv = seed ?? newConvergence(), t0 = Date.now();
  const scaffolded = await scaffoldFiles(ctx, conv, shouldScaffold);
  if (!scaffolded.ok) return err(scaffolded.error.code, scaffolded.error.message, scaffolded.error.details);
  const initial = await startInitialWrite(ctx, conv, warmSession, scaffolded.value);
  if (!initial.ok) return err(initial.error.code, initial.error.message, initial.error.details);
  const verifying = await ctx.d.queue.updateStatus(ctx.task.id, 'verifying', ctx.token);
  if (!verifying.ok) return err(verifying.error.code, verifying.error.message, verifying.error.details);
  const verified = await verifyLoop(
    ctx.d, initial.value.started.session, ctx.task, initial.value.started.output.tokenEstimate,
    initial.value.files, conv, t0, ctx.worktreePath, ctx.token, ctx.usage,
  );
  if (!verified.ok) return err(verified.error.code, verified.error.message, verified.error.details);
  if (ctx.d.config.reviewEnabled !== false) {
    const reviewing = await ctx.d.queue.updateStatus(ctx.task.id, 'reviewing', ctx.token);
    if (!reviewing.ok) return err(reviewing.error.code, reviewing.error.message, reviewing.error.details);
    const reviewed = await reviewPhase(ctx.d, initial.value.started.session, ctx.task, conv, t0, ctx.worktreePath, ctx.token, ctx.usage);
    if (!reviewed.ok) return err(reviewed.error.code, reviewed.error.message, reviewed.error.details);
  }
  return ok({ conv, started: initial.value.started, t0 });
}
