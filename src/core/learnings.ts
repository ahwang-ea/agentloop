import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, ClaudeAdapter, LearningEntry, NotifierAdapter, TaskDefinition } from '../types/index.js';
import { withArtifactLock, writeTextAtomically } from './artifact-lock.js';
import { addendumForTask, agentsPath, aggregate, pathOf, readLearnings, readText, recentMetrics } from './learnings-data.js';
import { requestCappedProposal } from './learnings-proposal.js';

export async function syncLearnings(config: Pick<AgentloopConfig, 'repoPath'>): Promise<Result<LearningEntry[]>> {
  const target = pathOf(config, 'learnings.json');
  return withArtifactLock(target, 'learnings', async () => {
    const recent = await recentMetrics(config); if (!recent.ok) return recent;
    const next = aggregate(recent.value.entries), current = await readText(target); if (!current.ok) return current;
    const serialized = JSON.stringify(next, null, 2), saved = current.value.trim() === serialized.trim() ? ok(undefined) : await writeTextAtomically(target, serialized);
    return saved.ok ? ok(next) : saved;
  });
}

export async function learningsAddendum(config: Pick<AgentloopConfig, 'repoPath'>, task: TaskDefinition): Promise<Result<string>> {
  const learnings = await readLearnings(pathOf(config, 'learnings.json')); if (!learnings.ok) return learnings;
  return ok(addendumForTask(learnings.value, task));
}

export async function maybeProposeAgentsUpdate(
  config: Pick<AgentloopConfig, 'repoPath' | 'agentsMdPath'>, claude: Pick<ClaudeAdapter, 'chat'>, notifier: Pick<NotifierAdapter, 'send'>,
): Promise<Result<boolean>> {
  const recent = await recentMetrics(config); if (!recent.ok || recent.value.total === 0 || recent.value.total % 20 !== 0) return recent.ok ? ok(false) : recent;
  const proposal = pathOf(config, 'proposed-agents-update.md');
  const existing = await readText(proposal); if (!existing.ok) return existing;
  if (existing.value.trim()) return ok(false);
  const agentsMd = await readText(agentsPath(config)); if (!agentsMd.ok) return err('TRANSPORT_ERROR', 'Cannot read AGENTS.md for proposal generation');
  const diff = await requestCappedProposal(claude, agentsMd.value, recent.value.entries); if (!diff.ok) return diff;
  const wrote = await withArtifactLock(proposal, 'proposal', async () => {
    const current = await readText(proposal); if (!current.ok) return current;
    if (current.value.trim()) return ok(false);
    const saved = await writeTextAtomically(proposal, diff.value);
    return saved.ok ? ok(true) : saved;
  });
  if (!wrote.ok || !wrote.value) return wrote;
  const sent = await notifier.send({ type: 'promotion-ready', summary: 'AGENTS.md update proposed. Review in repo.', details: `Review ${proposal}`, timestamp: new Date().toISOString(), idempotencyKey: `agents-proposal:${recent.value.total}` });
  return sent.ok ? ok(true) : sent;
}

export async function refreshLearnings(
  config: Pick<AgentloopConfig, 'repoPath' | 'agentsMdPath'>, claude: Pick<ClaudeAdapter, 'chat'>, notifier: Pick<NotifierAdapter, 'send'>,
): Promise<Result<void>> {
  const synced = await syncLearnings(config); if (!synced.ok) return synced;
  const proposed = await maybeProposeAgentsUpdate(config, claude, notifier);
  return proposed.ok ? ok(undefined) : proposed;
}
