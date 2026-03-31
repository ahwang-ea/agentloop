import { ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, ClaudeAdapter, CodexAdapter, FinalizationState, GitAdapter, NotifierAdapter, TaskDefinition, TaskQueueAdapter } from '../types/index.js';
import { formatFixPrompt, resolveConflicts, runSequentialReviews } from './reviewer.js';
import { remainingFeatureTasks } from './feature.js';
import { refreshFeatureDocs } from './feature-docs.js';
import { mergeFeatureAtomically } from './feature-merge.js';
import { diffInventories, needsArchitectureUpdate } from './inventory-diff.js';
import { ensureIntentBaseline } from './intent-check.js';
import { scanRepo } from './scanner.js';
import { worktreePathForBranch } from './worktree.js';

interface FeatureDeps {
  claude: ClaudeAdapter;
  codex: CodexAdapter;
  git: GitAdapter;
  notifier: NotifierAdapter;
  queue: TaskQueueAdapter;
  config: AgentloopConfig;
}

const docsChanged = (diff: string) => /^\+\+\+ b\/(AGENTS|ARCHITECTURE)\.md$/m.test(diff);
const gateTask = (task: TaskDefinition): TaskDefinition => ({ ...task, title: `Feature gate: ${task.feature ?? task.title}`, acceptanceCriteria: ['Feature diff is coherent and correct.'] });

export async function prepareFeatureFinalization(
  d: FeatureDeps, task: TaskDefinition, fin: FinalizationState, token: string,
): Promise<Result<'continue' | 'done'>> {
  if (!task.feature || fin.featureMerged) return ok('continue');
  const feature = task.feature, persist = async () => d.queue.updateFinalization(task.id, fin, token);
  const tasks = await d.queue.list(); if (!tasks.ok) return tasks;
  if (remainingFeatureTasks(tasks.value, feature, task.id).length > 0) {
    if (!fin.rebaseDone) {
      const rb = await d.git.rebaseAll(fin.mergeInto, fin.branch); if (!rb.ok) return rb;
      fin.rebaseDone = true; const saved = await persist(); if (!saved.ok) return saved;
    }
    const done = await d.queue.markDone(task.id, token);
    return done.ok ? ok('done') : done;
  }
  const base = await d.git.checkoutBase(d.config.baseBranch); if (!base.ok) return base;
  const before = await scanRepo(base.value); if (!before.ok) return before;
  const diff = await d.git.getDiff(d.config.baseBranch, fin.featureBranch ?? fin.mergeInto); if (!diff.ok) return diff;
  if (!d.config.autoApproveFeatures) {
    const reviews = await runSequentialReviews(d, gateTask(task), diff.value); if (!reviews.ok) return reviews;
    const resolved = resolveConflicts(reviews.value.flatMap(review => review.findings));
    if (!resolved.ok) {
      const blocked = await d.queue.markBlocked(task.id, resolved.error.message, resolved.error.details ?? {}, token);
      return blocked.ok ? ok('done') : blocked;
    }
    if (resolved.value.length > 0) {
      const blocked = await d.queue.markBlocked(task.id, `Feature gate findings for ${feature}`, { findings: formatFixPrompt(resolved.value) }, token);
      return blocked.ok ? ok('done') : blocked;
    }
  }
  const after = await scanRepo(worktreePathForBranch(d.config, fin.featureBranch ?? fin.mergeInto)); if (!after.ok) return after;
  const delta = diffInventories(before.value, after.value), updateDocs = needsArchitectureUpdate(delta) && !docsChanged(diff.value);
  const baseline = await ensureIntentBaseline(d.config.repoPath, before.value); if (!baseline.ok) return baseline;
  if (d.config.autoApproveFeatures) fin.approved = true;
  if (!fin.approved) {
    if (!fin.approvalRequested) {
      const sent = await d.notifier.send({
        type: 'promotion-ready',
        taskId: task.id,
        summary: `Feature ${feature} passed automated gate`,
        details: `New modules: ${delta.newModules.length}, new dependencies: ${delta.newDependencies.length}, new env vars: ${delta.newEnvVars.length}, constraint changes: ${delta.constraintChanges.length}. Approve with: agentloop approve ${task.id}`,
        timestamp: new Date().toISOString(),
        idempotencyKey: `feature-gate:${feature}:${fin.mergeCommit}`,
      });
      if (!sent.ok) return sent;
      fin.approvalRequested = true;
      const saved = await persist(); if (!saved.ok) return saved;
    }
    const blocked = await d.queue.markBlocked(task.id, `Awaiting human approval for feature ${feature}`, { feature, featureBranch: fin.featureBranch ?? fin.mergeInto, command: `agentloop approve ${task.id}` }, token);
    return blocked.ok ? ok('done') : blocked;
  }
  const merged = await mergeFeatureAtomically(d.git, fin.featureBranch ?? fin.mergeInto, d.config.baseBranch, `merge: ${feature}`,
    updateDocs ? () => refreshFeatureDocs(d.claude, d.config.verifyCommand, base.value, feature, delta) : undefined);
  if (!merged.ok) return merged;
  Object.assign(fin, { mergeCommit: merged.value, mergeInto: d.config.baseBranch, branch: fin.featureBranch ?? fin.branch, featureMerged: true, rebaseDone: false });
  const saved = await persist();
  return saved.ok ? ok('continue') : saved;
}
