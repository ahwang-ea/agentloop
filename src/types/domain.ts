// types/domain.ts — Core domain types for the orchestrator.

export type TaskStatus =
  | 'queued' | 'writing' | 'verifying' | 'reviewing' | 'fixing'
  | 'cleanup' | 'merging' | 'finalizing' | 'done' | 'stuck' | 'blocked';
export type TaskPriority = 'low' | 'medium' | 'high';
export type TaskType = 'research' | 'implement' | 'integrate' | 'debug';
export type ModelPreference = 'claude' | 'auto';

export interface TaskDefinition {
  id: string;
  title: string;
  description: string;
  feature?: string;
  type: TaskType;
  scope: TaskScope;
  acceptanceCriteria: string[];
  model?: ModelPreference;
  priority: TaskPriority;
  createdAt: string;
}
export type TaskInput = Omit<TaskDefinition, 'id' | 'createdAt' | 'type'> & { type?: TaskType };

export interface TaskScope { editableFiles: string[]; readOnlyContext: string[]; forbiddenFiles: string[]; }

export interface FinalizationState {
  mergeCommit: string;
  branch: string;
  mergeInto: string;
  featureBranch?: string;
  approvalRequested?: boolean;
  approved?: boolean;
  featureMerged?: boolean;
  intentChecked?: boolean;
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
  stuckReason?: string;
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
  reviewFindings: number;
  errorTypes: string[];
  changedFiles: string[];
}
export interface ConvergenceConfig { maxWallClock: number; maxTokens: number; stuckThreshold: number; thrashOverlapRatio: number; }

export interface ScaffoldOutput { files: ScaffoldFile[]; }
export type ScaffoldFile =
  | { type: 'types' | 'stub' | 'test'; path: string; content: string }
  | { type: 'golden-copy'; path: string; referencePath: string };

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

export interface BranchState { name: string; createdFrom: string; worktreePath: string; }
export type NotificationType = 'behavior-change' | 'escalation' | 'sweep-result' | 'promotion-ready' | 'intent-check';
export interface Notification { type: NotificationType; taskId?: string; summary: string; details: string; timestamp: string; idempotencyKey?: string; }

export type MetricsOutcome = 'merged' | 'stuck' | 'blocked' | 'needs-human';
export interface TaskMetricsStats {
  rounds: number;
  timeSec: number;
  reviewFindings: number;
  errors: string[];
  files: string[];
  timestamp: string;
}
export interface MetricsRecord extends TaskMetricsStats {
  task_id: string;
  task: string;
  outcome: MetricsOutcome;
}
export interface LearningEntry { pattern: string; module: string; count: number; lastSeen: string; suggestion: string; }

export interface InventoryFile { path: string; lines: number; }
export interface InventoryPackage { name: string; path: string; }
export interface InventoryDoc { path: string; modifiedAt: string; }
export interface InventoryDependencyFile { path: string; kind: 'package.json' | 'pyproject.toml'; dependencies: string[]; }
export interface RepoInventory {
  scannedAt: string;
  files: InventoryFile[];
  monorepo: boolean;
  packages: InventoryPackage[];
  crossPackageImports: string[];
  patterns: { resultCount: number; tryCatchCount: number; serviceFileCount: number; controllerFileCount: number; };
  tests: { frameworks: string[]; count: number; };
  docs: InventoryDoc[];
  dependencies: InventoryDependencyFile[];
  env: { example: string[]; referenced: string[]; missingInExample: string[]; unusedInExample: string[]; };
  oversizedFiles: string[];
  ci: string[];
  importFrequency: Array<{ path: string; importedBy: number }>;
}
