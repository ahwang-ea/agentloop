import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, ClaudeAdapter, GitAdapter, NotifierAdapter, TaskDefinition, TaskQueueAdapter } from '../types/index.js';
import { learningsAddendum, refreshLearnings } from './learnings.js';
import { withLease } from './lease.js';
import { logTaskMetrics } from './metrics.js';
import { buildWritePrompt } from './writer-prompt.js';

interface ResearchDeps {
  claude: ClaudeAdapter;
  git: GitAdapter;
  notifier: NotifierAdapter;
  queue: TaskQueueAdapter;
  config: Pick<AgentloopConfig, 'baseBranch' | 'repoPath' | 'agentsMdPath' | 'autoApproveResearch'>;
}
const unique = (items: string[]) => [...new Set(items)];
const approvalReason = 'awaiting human approval of research output';
const scoped = (task: TaskDefinition): TaskDefinition => ({
  ...task,
  scope: {
    editableFiles: ['src/adapters/**/*', '.agentloop/research/**/*', 'ARCHITECTURE.md'],
    readOnlyContext: unique(['ARCHITECTURE.md', ...task.scope.readOnlyContext, ...task.scope.editableFiles]),
    forbiddenFiles: task.scope.forbiddenFiles,
  },
});
const promptOf = async (repoPath: string, task: TaskDefinition) => {
  const learnings = await learningsAddendum({ repoPath }, task);
  return learnings.ok && learnings.value ? `${buildWritePrompt(task)}\n\n${learnings.value}` : buildWritePrompt(task);
};

export async function runResearchTask(
  d: ResearchDeps, task: TaskDefinition, branch: string, cwd: string, token: string,
): Promise<Result<void>> {
  const scopedTask = scoped(task), prompt = await promptOf(d.config.repoPath, scopedTask);
  const session = await withLease(() => d.claude.startSession(scopedTask, cwd, undefined, prompt), () => d.queue.renewClaim(task.id, token));
  if (!session.ok) return session;
  const output = await withLease(() => d.claude.waitForStop(session.value), () => d.queue.renewClaim(task.id, token));
  if (!output.ok) return output;
  if (!output.value.text.trim() && output.value.changedFiles.length === 0) return err('EMPTY_RESPONSE', 'Research task produced no output');
  const commit = await d.git.commit(`research: ${task.title}`, branch); if (!commit.ok) return commit;
  const blocked = await d.queue.markBlocked(task.id, approvalReason, { kind: 'research-approval', command: `agentloop approve ${task.id}` }, token);
  if (!blocked.ok) return blocked;
  const logged = await logTaskMetrics(d.config, d.queue, task, 'blocked'); if (!logged.ok) console.error(logged.error.message);
  else { const learned = await refreshLearnings(d.config, d.claude, d.notifier); if (!learned.ok) console.error(learned.error.message); }
  const notice = await d.notifier.send({
    type: 'promotion-ready',
    taskId: task.id,
    summary: `Research ready: ${task.title}`,
    details: `Review the research branch ${branch} and approve with: agentloop approve ${task.id}`,
    timestamp: new Date().toISOString(),
    idempotencyKey: `research:${task.id}`,
  });
  if (!notice.ok) console.error(notice.error.message);
  if (!d.config.autoApproveResearch) return ok(undefined);
  const approved = await d.queue.approveBlocked(task.id);
  return approved.ok ? ok(undefined) : approved;
}
