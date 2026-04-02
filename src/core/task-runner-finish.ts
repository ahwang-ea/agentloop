import { err, type Result } from '../shared/result.js';
import { recordSessionChanges, recordVerifyErrors } from './metrics.js';
import { addTaskTokens } from './session-budget.js';
import { withLease } from './lease.js';
import { commitAndMergeTask } from './task-merge.js';
import type { TaskRunContext, TaskRunState } from './task-runner-setup.js';
import { writeCurrentScope } from './scope-file.js';
import { progressiveVerify } from './verifier.js';
import { runWriterCleanup } from './writer.js';

const shouldLogVerify = () => process.env.AGENTLOOP_LOG_VERIFY === '1';
const saveProgress = (ctx: TaskRunContext, state: TaskRunState) => ctx.d.queue.updateProgress(
  ctx.task.id,
  { round: state.conv.rounds.length, convergence: state.conv },
  ctx.token,
);

export async function finishTaskRun(ctx: TaskRunContext, state: TaskRunState): Promise<Result<void>> {
  if (ctx.d.config.skipCleanup !== true) {
    const cleanupStatus = await ctx.d.queue.updateStatus(ctx.task.id, 'cleanup', ctx.token);
    if (!cleanupStatus.ok) return err(cleanupStatus.error.code, cleanupStatus.error.message, cleanupStatus.error.details);
    const cleanupScope = await writeCurrentScope(ctx.worktreePath, ctx.task, 'cleanup');
    if (!cleanupScope.ok) return err(cleanupScope.error.code, cleanupScope.error.message, cleanupScope.error.details);
    const cleanup = await withLease(
      () => runWriterCleanup(ctx.d, state.started.session, ctx.task, ctx.worktreePath),
      () => ctx.d.queue.renewClaim(ctx.task.id, ctx.token),
    );
    if (!cleanup.ok) return err(cleanup.error.code, cleanup.error.message, cleanup.error.details);
    addTaskTokens(ctx.usage, cleanup.value.tokenEstimate);
    recordSessionChanges(state.conv, cleanup.value.changedFiles);
    const progress = await saveProgress(ctx, state);
    if (!progress.ok) return err(progress.error.code, progress.error.message, progress.error.details);
    if (cleanup.value.changedFiles.length > 0) {
      const verifying = await ctx.d.queue.updateStatus(ctx.task.id, 'verifying', ctx.token);
      if (!verifying.ok) return err(verifying.error.code, verifying.error.message, verifying.error.details);
    }
  }
  const finalVerify = await withLease(
    () => progressiveVerify(ctx.d.config, state.conv.changedFiles, ctx.worktreePath, true, ctx.task.type),
    () => ctx.d.queue.renewClaim(ctx.task.id, ctx.token),
  );
  if (!finalVerify.ok) return err(finalVerify.error.code, finalVerify.error.message, finalVerify.error.details);
  if (shouldLogVerify()) {
    console.error(`[verify] ${ctx.task.id} merge ${finalVerify.value.pass ? 'pass' : 'fail'} files=${state.conv.changedFiles.join(', ') || '(none)'}`);
    if (!finalVerify.value.pass) console.error(finalVerify.value.output);
  }
  if (!finalVerify.value.pass) {
    recordVerifyErrors(state.conv, finalVerify.value.errors);
    const updated = await saveProgress(ctx, state);
    if (!updated.ok) return err(updated.error.code, updated.error.message, updated.error.details);
    return err('VERIFY_FAILED', 'Final verify failed before merge');
  }
  const merging = await ctx.d.queue.updateStatus(ctx.task.id, 'merging', ctx.token);
  if (!merging.ok) return err(merging.error.code, merging.error.message, merging.error.details);
  return commitAndMergeTask(ctx.d.git, ctx.d.queue, ctx.task, ctx.branch, ctx.mergeInto, ctx.token, `feat: ${ctx.task.title}`);
}
