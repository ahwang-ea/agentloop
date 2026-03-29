// types/domain.ts — Core domain types for the orchestrator.

export type TaskStatus =
  | 'queued' | 'writing' | 'verifying' | 'reviewing' | 'fixing'
  | 'cleanup' | 'merging' | 'finalizing' | 'done' | 'stuck' | 'blocked';
export type TaskPriority = 'low' | 'medium' | 'high';
export type ModelPreference = 'claude' | 'auto';

export interface TaskDefinition {
  id: string;
  title: string;
  description: string;
  scope: TaskScope;
  acceptanceCriteria: string[];
  model: ModelPreference;
  priority: TaskPriority;
  createdAt: string;
}

export interface TaskScope { editableFiles: string[]; readOnlyContext: string[]; forbiddenFiles: string[]; }

export interface FinalizationState {
  mergeCommit: string;
  branch: string;
  behaviorNotified: boolean;
  readmeTaskEnsured: boolean;
  completionNotified: boolean;
  rebaseDone: boolean;
  failCount: number;
}

export interface BlockedState { reason: string; details: Record<string, unknown>; blockedAt: string; }

export interface TaskState {
  task: TaskDefinition;
  status: TaskStatus;
  branch?: string;
  round: number;
  convergence?: ConvergenceState;
  finalization?: FinalizationState;
  blocked?: BlockedState;
  startedAt: string;
  completedAt?: string;
}

export interface ConvergenceRound { round: number; issueCount: number; issueHashes: string[]; elapsed: number; tokens: number; }
export interface ConvergenceState {
  rounds: ConvergenceRound[];
  classification: 'converging' | 'stuck' | 'thrashing' | 'unknown';
  webSearchTriggered: boolean;
}
export interface ConvergenceConfig { maxWallClock: number; maxTokens: number; stuckThreshold: number; thrashOverlapRatio: number; }

export interface VerifyResult { pass: boolean; output: string; errors: VerifyError[]; duration: number; }
export interface VerifyError { source: 'typecheck' | 'test' | 'lint' | 'build' | 'doc-freshness'; message: string; file?: string; line?: number; hash: string; }

export type ReviewerRole = 'opus-bigpicture' | 'codex-detail';
export interface ReviewRequest { diff: string; taskDefinition: TaskDefinition; architectureMd?: string; agentsMd: string; role: ReviewerRole; }
export type FindingAction = 'keep' | 'change' | 'remove' | 'rename' | 'extract';

interface ReviewFindingBase { reviewer: ReviewerRole; description: string; file?: string; line?: number; }
interface IssueFinding extends ReviewFindingBase { severity: 'issue'; topicKey: string; action: FindingAction; }
interface SuggestionFinding extends ReviewFindingBase { severity: 'suggestion'; topicKey?: string; action?: FindingAction; }
export type ReviewFinding = IssueFinding | SuggestionFinding;
export interface ReviewResult { reviewer: ReviewerRole; findings: ReviewFinding[]; duration: number; rawOutput: string; }

export interface BehaviorChange { type: 'endpoint' | 'response-shape' | 'error-behavior' | 'config' | 'schema' | 'auth' | 'timing'; description: string; files: string[]; }
export interface BehaviorCheckResult { hasChanges: boolean; changes: BehaviorChange[]; readmeUpdateNeeded: boolean; }

export interface BranchState { name: string; createdFrom: string; }
export type NotificationType = 'behavior-change' | 'escalation' | 'sweep-result' | 'promotion-ready';
export interface Notification { type: NotificationType; taskId?: string; summary: string; details: string; timestamp: string; idempotencyKey?: string; }
