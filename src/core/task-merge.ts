import { err, ok, type Result } from '../shared/result.js';
import type { FinalizationState, GitAdapter, TaskDefinition, TaskQueueAdapter } from '../types/index.js';

const finalization = (task: TaskDefinition, mergeCommit: string, branch: string, mergeInto: string): FinalizationState => ({
  mergeCommit,
  branch,
  mergeInto,
  featureBranch: task.feature ? mergeInto : undefined,
  approvalRequested: !task.feature,
  approved: !task.feature,
  featureMerged: !task.feature,
  intentChecked: !task.feature,
  behaviorNotified: false,
  readmeTaskEnsured: false,
  completionNotified: false,
  rebaseDone: false,
  failCount: 0,
});

export async function mergeCommittedBranch(
  git: GitAdapter, queue: TaskQueueAdapter, task: TaskDefinition, branch: string, mergeInto: string, token: string,
): Promise<Result<void>> {
  const co = await git.checkoutBase(mergeInto); if (!co.ok) return err(co.error.code, `checkoutBase failed: ${co.error.message}`, co.error.details);
  const merge = await git.merge(branch, mergeInto);
  if (!merge.ok) {
    const ab = await git.abortMerge(mergeInto);
    if (!ab.ok) return err(merge.error.code, `${merge.error.message}; abortMerge also failed: ${ab.error.message}`, { mergeError: merge.error, abortError: ab.error });
    return err(merge.error.code, merge.error.message, merge.error.details);
  }
  const begun = await queue.beginFinalization(task.id, finalization(task, merge.value, branch, mergeInto), token);
  return begun.ok ? ok(undefined) : err('FINALIZATION_PERSIST_FAILED', `Merge succeeded (${merge.value}) but beginFinalization failed: ${begun.error.message}`, { mergeCommit: merge.value, branch });
}

export async function commitAndMergeTask(
  git: GitAdapter, queue: TaskQueueAdapter, task: TaskDefinition, branch: string, mergeInto: string, token: string, message: string,
): Promise<Result<void>> {
  const commit = await git.commit(message, branch); if (!commit.ok) return commit;
  return mergeCommittedBranch(git, queue, task, branch, mergeInto, token);
}
