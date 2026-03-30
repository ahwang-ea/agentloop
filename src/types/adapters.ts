// types/adapters.ts — Adapter interfaces and orchestrator events.

import type { Result } from '../shared/result.js';
import type {
  BranchState,
  FinalizationState,
  Notification,
  ReviewFinding,
  ReviewRequest,
  ReviewResult,
  ScaffoldOutput,
  TaskDefinition,
  TaskInput,
  TaskState,
  TaskStatus,
} from './domain.js';

export interface WriterOutput {
  text: string;
  changedFiles: string[];
  tokenEstimate: number;
}
export interface SessionOutput {
  text: string;
  tokensDelta: number;
  changedFiles: string[];
  stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_hook';
}
export interface ClaudeSession { id: string; taskId: string; }

export interface ClaudeAdapter {
  startSession(task: TaskDefinition, cwd: string, reuse?: ClaudeSession, prompt?: string): Promise<Result<ClaudeSession>>;
  waitForStop(session: ClaudeSession): Promise<Result<WriterOutput>>;
  fix(session: ClaudeSession, errors: string): Promise<Result<WriterOutput>>;
  cleanup(session: ClaudeSession): Promise<Result<WriterOutput>>;
  review(request: ReviewRequest): Promise<Result<ReviewResult>>;
  chat(message: string): Promise<Result<SessionOutput>>;
  scaffold(task: TaskDefinition): Promise<Result<ScaffoldOutput>>;
  evictTaskSessions(taskId: string): Promise<Result<void>>;
}

export interface CodexAdapter { review(request: ReviewRequest): Promise<Result<ReviewResult>>; }
export interface CodexWriterAdapter {
  write(prompt: string, cwd: string): Promise<Result<WriterOutput>>;
  fix(prompt: string, cwd: string): Promise<Result<WriterOutput>>;
}

export interface GitAdapter {
  createBranch(name: string, from?: string): Promise<Result<BranchState>>;
  checkoutBranch(name: string): Promise<Result<void>>;
  checkoutBase(base: string): Promise<Result<void>>;
  commit(message: string, branch: string): Promise<Result<string>>;
  commitBase(message: string, base: string): Promise<Result<string>>;
  getDiff(from: string, to?: string): Promise<Result<string>>;
  merge(branch: string, into: string): Promise<Result<string>>;
  prepareMerge(branch: string, into: string): Promise<Result<void>>;
  abortMerge(into: string): Promise<Result<void>>;
  abandonBranch(branch: string): Promise<Result<void>>;
  rebaseAll(base: string, except: string): Promise<Result<void>>;
  revertFiles(paths: string[], cwd: string): Promise<Result<void>>;
  currentBranch(): Promise<Result<string>>;
}

export interface NotifierAdapter { send(notification: Notification): Promise<Result<void>>; }
export type ActionableTaskState =
  | ({ status: 'writing' | 'merging'; task: TaskDefinition } & Pick<TaskState, 'branch' | 'round' | 'convergence'>)
  | { status: 'finalizing'; task: TaskDefinition; finalization: FinalizationState };
export interface ClaimedActionableTask { state: ActionableTaskState; claimToken: string; }

export interface TaskQueueAdapter {
  claimNextActionable(maxParallelAgents: number): Promise<Result<ClaimedActionableTask | null>>;
  renewClaim(taskId: string, claimToken: string): Promise<Result<void>>;
  updateStatus(taskId: string, status: TaskStatus, claimToken: string): Promise<Result<void>>;
  updateProgress(taskId: string, progress: Pick<TaskState, 'branch' | 'round' | 'convergence'>, claimToken: string): Promise<Result<void>>;
  beginFinalization(taskId: string, finalization: FinalizationState, claimToken: string): Promise<Result<void>>;
  updateFinalization(taskId: string, finalization: FinalizationState, claimToken: string): Promise<Result<void>>;
  markDone(taskId: string, claimToken: string): Promise<Result<void>>;
  markStuck(taskId: string, reason: string, claimToken: string): Promise<Result<void>>;
  markBlocked(taskId: string, reason: string, details: Record<string, unknown>, claimToken: string): Promise<Result<void>>;
  requeueBlocked(taskId: string): Promise<Result<void>>;
  approveBlocked(taskId: string): Promise<Result<void>>;
  releaseClaim(taskId: string, claimToken: string): Promise<Result<void>>;
  add(task: TaskInput): Promise<Result<TaskDefinition>>;
  ensureTask(dedupeKey: string, task: TaskInput): Promise<Result<TaskDefinition>>;
  countByDedupePrefix(prefix: string): Promise<Result<number>>;
  list(): Promise<Result<TaskState[]>>;
}

export type OrchestratorEvent =
  | { type: 'TASK_PICKED'; task: TaskDefinition }
  | { type: 'WRITE_COMPLETE' }
  | { type: 'VERIFY_PASS' }
  | { type: 'VERIFY_FAIL'; errors: string[] }
  | { type: 'REVIEW_CLEAN' }
  | { type: 'REVIEW_FINDINGS'; findings: ReviewFinding[] }
  | { type: 'FIX_COMPLETE' }
  | { type: 'CLEANUP_COMPLETE' }
  | { type: 'MERGE_COMPLETE' }
  | { type: 'BLOCKED'; reason: string }
  | { type: 'STUCK'; reason: string }
  | { type: 'THRASHING'; pattern: string }
  | { type: 'OPERATOR_INPUT'; message: string }
  | { type: 'SWEEP_DUE' }
  | { type: 'QUEUE_EMPTY' };
