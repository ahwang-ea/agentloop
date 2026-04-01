// orchestrator.ts — Core state machine. Each transition is code, not a prompt.
import type { AgentloopConfig, ClaudeAdapter, CodexAdapter, CodexWriterAdapter, GitAdapter, NotifierAdapter, TaskQueueAdapter } from './types/index.js';
import { ok, type Result } from './shared/result.js';
import { runPlanningWorker } from './core/planning-worker.js';
import { runWorker } from './core/orchestrator-worker.js';

export interface Deps { claude: ClaudeAdapter; codex: CodexAdapter; codexWriter: CodexWriterAdapter; git: GitAdapter; notifier: NotifierAdapter; queue: TaskQueueAdapter; config: AgentloopConfig; }
export interface SharedState { sweepCounter: number; sweep?: Promise<Result<void>>; scaffoldPlanning: Set<string>; }

export async function implementationWorker(deps: Deps, shared: SharedState, deadlineAt?: number): Promise<Result<void>> {
  return runWorker(deps, shared, deadlineAt);
}

export async function planningWorker(deps: Deps, shared: SharedState, deadlineAt?: number): Promise<Result<void>> {
  return runPlanningWorker(deps, shared, deadlineAt);
}

export async function runOrchestrator(deps: Deps, deadlineAt?: number): Promise<Result<void>> {
  const shared: SharedState = { sweepCounter: 0, scaffoldPlanning: new Set() }, count = Math.max(1, deps.config.maxParallelAgents);
  const results = await Promise.all([planningWorker(deps, shared, deadlineAt), ...Array.from({ length: count }, () => implementationWorker(deps, shared, deadlineAt))]);
  const failure = results.find(result => !result.ok);
  return failure ?? ok(undefined);
}
