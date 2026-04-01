// orchestrator.ts — Core state machine. Each transition is code, not a prompt.
import type { AgentloopConfig, ClaudeAdapter, CodexAdapter, CodexWriterAdapter, GitAdapter, NotifierAdapter, TaskQueueAdapter } from './types/index.js';
import { ok, type Result } from './shared/result.js';
import { runWorker } from './core/orchestrator-worker.js';

export interface Deps { claude: ClaudeAdapter; codex: CodexAdapter; codexWriter: CodexWriterAdapter; git: GitAdapter; notifier: NotifierAdapter; queue: TaskQueueAdapter; config: AgentloopConfig; }

export async function runOrchestrator(deps: Deps, deadlineAt?: number): Promise<Result<void>> {
  const shared = { sweepCounter: 0 }, count = Math.max(1, deps.config.maxParallelAgents);
  const results = await Promise.all(Array.from({ length: count }, () => runWorker(deps, shared, deadlineAt)));
  const failure = results.find(result => !result.ok);
  return failure ?? ok(undefined);
}
