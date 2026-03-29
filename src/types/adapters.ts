// types/adapters.ts — Adapter interfaces and orchestrator events.

import type { Result } from '../shared/result.js';
import type {
  TaskDefinition, TaskState, TaskStatus, FinalizationState,
  ReviewRequest, ReviewResult, ReviewFinding, BranchState, Notification,
} from './domain.js';

export interface SessionOutput {
  text: string;
  tokensDelta: number;
  changedFiles: string[];
  stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_hook';
}

export interface ClaudeSession { id: string; taskId: string; }

export interface ClaudeAdapter {
  startSession(task: TaskDefinition): Promise<Result<ClaudeSession>>;
  waitForStop(session: ClaudeSession): Promise<Result<SessionOutput>>;
  fix(session: ClaudeSession, errors: string): Promise<Result<SessionOutput>>;
  cleanup(session: ClaudeSession): Promise<Result<SessionOutput>>;
  review(request: ReviewRequest): Promise<Result<ReviewResult>>;
  chat(message: string): Promise<Result<SessionOutput>>;
}

export interface CodexAdapter { review(request: ReviewRequest): Promise<Result<ReviewResult>>; }

export interface GitAdapter {
  createBranch(name: string, from?: string): Promise<Result<BranchState>>;
  checkoutBranch(name: string): Promise<Result<void>>;
  checkoutBase(base: string): Promise<Result<void>>;
  commit(message: string): Promise<Result<string>>;
  getDiff(from: string, to?: string): Promise<Result<string>>;
  merge(branch: string, into: string): Promise<Result<string>>;
  abortMerge(): Promise<Result<void>>;
  abandonBranch(branch: string): Promise<Result<void>>;
  rebaseAll(base: string, except: string): Promise<Result<void>>;
  currentBranch(): Promise<Result<string>>;
}

export interface NotifierAdapter { send(notification: Notification): Promise<Result<void>>; }

export type ActionableTaskState =
  | ({ status: 'writing'; task: TaskDefinition } & Pick<TaskState, 'branch' | 'round' | 'convergence'>)
  | { status: 'finalizing'; task: TaskDefinition; finalization: FinalizationState };

export interface ClaimedActionableTask { state: ActionableTaskState; claimToken: string; }

export interface TaskQueueAdapter {
  /** Claims queued work, expired active pre-merge work as `writing` with persisted progress, or finalizing retries. */
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
  releaseClaim(taskId: string, claimToken: string): Promise<Result<void>>;
  add(task: Omit<TaskDefinition, 'id' | 'createdAt'>): Promise<Result<TaskDefinition>>;
  ensureTask(dedupeKey: string, task: Omit<TaskDefinition, 'id' | 'createdAt'>): Promise<Result<TaskDefinition>>;
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
