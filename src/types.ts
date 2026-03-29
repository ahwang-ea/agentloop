// ============================================================
// agentloop — types.ts
// All interfaces for the autonomous AI coding orchestrator.
// Types-first: everything else implements against these.
// ============================================================

import type { Result } from './shared/result.js';

// --- Task ---

export type TaskStatus = 'queued' | 'writing' | 'verifying' | 'reviewing' | 'fixing' | 'cleanup' | 'merging' | 'done' | 'stuck';
export type TaskPriority = 'low' | 'medium' | 'high';
export type ModelPreference = 'claude' | 'codex' | 'auto';

export interface TaskDefinition {
  id: string;
  title: string;
  description: string;
  scope: TaskScope;
  acceptanceCriteria: string[];
  model: ModelPreference;
  priority: TaskPriority;
  createdAt: Date;
}

export interface TaskScope {
  editableFiles: string[];       // Globs or explicit paths agent MAY edit
  readOnlyContext: string[];     // Files loaded for context but not editable
  forbiddenFiles: string[];     // Never touch — hooks enforce this
}

export interface TaskState {
  task: TaskDefinition;
  status: TaskStatus;
  branch: string;
  round: number;
  convergence: ConvergenceState;
  startedAt: Date;
  completedAt?: Date;
}

// --- Convergence ---

export interface ConvergenceRound {
  round: number;
  issueCount: number;
  issueHashes: string[];         // Hash of each unique error for comparison
  elapsed: number;               // Seconds
  tokens: number;                // Approximate token usage
}

export interface ConvergenceState {
  rounds: ConvergenceRound[];
  classification: 'converging' | 'stuck' | 'thrashing' | 'unknown';
  webSearchTriggered: boolean;   // Whether we searched after repeated error
}

export interface ConvergenceConfig {
  maxWallClock: number;          // Seconds — hard ceiling (default 1800)
  maxTokens: number;             // Token budget ceiling (default 500000)
  stuckThreshold: number;        // Same error N rounds = stuck (default 3)
  thrashOverlapRatio: number;    // % overlap with 2-ago = thrashing (default 0.5)
}

// --- Verification ---

export interface VerifyResult {
  pass: boolean;
  output: string;                // Raw stdout/stderr from verify.sh
  errors: VerifyError[];         // Parsed structured errors
  duration: number;              // Seconds
}

export interface VerifyError {
  source: 'typecheck' | 'test' | 'lint' | 'build' | 'doc-freshness';
  message: string;
  file?: string;
  line?: number;
  hash: string;                  // For convergence comparison
}

// --- Review ---

export type ReviewerRole = 'opus-bigpicture' | 'codex-detail';

export interface ReviewRequest {
  diff: string;
  taskDefinition: TaskDefinition;
  architectureMd: string;        // Full ARCHITECTURE.md content
  agentsMd: string;              // Full AGENTS.md content
  role: ReviewerRole;
}

export interface ReviewFinding {
  reviewer: ReviewerRole;
  severity: 'issue' | 'suggestion';
  description: string;
  file?: string;
  line?: number;
}

export interface ReviewResult {
  reviewer: ReviewerRole;
  findings: ReviewFinding[];
  clean: boolean;                // No issues found
  duration: number;
}

// --- Behavior Change Detection ---

export interface BehaviorChange {
  type: 'endpoint' | 'response-shape' | 'error-behavior' | 'config' | 'schema' | 'auth' | 'timing';
  description: string;
  files: string[];
}

export interface BehaviorCheckResult {
  hasChanges: boolean;
  changes: BehaviorChange[];
  readmeUpdateNeeded: boolean;
}

// --- Git / Branch ---

export interface BranchState {
  name: string;
  taskId: string;
  createdFrom: string;           // Commit SHA of main when branched
  commits: number;
  status: 'active' | 'merged' | 'abandoned';
}

// --- Notifications ---

export type NotificationType = 'behavior-change' | 'escalation' | 'sweep-result' | 'promotion-ready';

export interface Notification {
  type: NotificationType;
  taskId?: string;
  summary: string;
  details: string;
  timestamp: Date;
}

// --- Orchestrator Config ---

export interface AgentloopConfig {
  // Paths
  repoPath: string;
  verifyCommand: string;          // Default: ./verify.sh
  agentsMdPath: string;           // Default: AGENTS.md
  architectureMdPath: string;     // Default: ARCHITECTURE.md

  // Models
  claudeModel: string;            // Default: claude-opus-4-6
  codexEnabled: boolean;           // Default: true

  // Convergence
  convergence: ConvergenceConfig;

  // Notifications
  slackWebhookUrl?: string;

  // Task source
  taskSource: 'file' | 'linear';  // Where to read tasks from
  taskFilePath?: string;           // If file-based: path to TODO.md or tasks.json
  linearApiKey?: string;           // If Linear-based
  linearTeamId?: string;

  // Parallelism
  maxParallelAgents: number;       // Default: 1
  parallelVerify: boolean;         // Run tsc/test/lint in parallel (default: true)

  // Sweep
  sweepInterval: number;           // Tasks between architect sweeps (default: 10)
}

// --- Hook Configuration (for .claude/settings.json) ---

export interface HookConfig {
  hooks: {
    PostToolUse: HookEntry[];      // After file edits → verify
    PreToolUse: HookEntry[];       // Before edits → scope check
    Stop: HookEntry[];             // Session end → cleanup signal
    UserPromptSubmit?: HookEntry[];// Optional: validate prompts
  };
}

export interface HookEntry {
  matcher: string;                  // Regex: "Write|Edit|MultiEdit" etc
  hooks: HookHandler[];
}

export interface HookHandler {
  type: 'command' | 'http' | 'prompt' | 'agent';
  command?: string;                 // For type: command
  url?: string;                     // For type: http
  prompt?: string;                  // For type: prompt
}

// --- CLI ---

export interface InitOptions {
  projectName: string;
  stack: 'typescript' | 'python' | 'mixed';
  goals: string;                    // Plain English project goals
}

export interface StartOptions {
  config?: Partial<AgentloopConfig>;
  interactive: boolean;             // Chat mode vs headless
  dryRun: boolean;                  // Show what would happen without executing
}

// --- Orchestrator State Machine ---

export type OrchestratorEvent =
  | { type: 'TASK_PICKED'; task: TaskDefinition }
  | { type: 'WRITE_COMPLETE' }
  | { type: 'VERIFY_PASS' }
  | { type: 'VERIFY_FAIL'; result: VerifyResult }
  | { type: 'REVIEW_CLEAN' }
  | { type: 'REVIEW_FINDINGS'; findings: ReviewFinding[] }
  | { type: 'FIX_COMPLETE' }
  | { type: 'CLEANUP_COMPLETE' }
  | { type: 'MERGE_COMPLETE'; behaviorChanges: BehaviorChange[] }
  | { type: 'STUCK'; reason: string }
  | { type: 'THRASHING'; pattern: string }
  | { type: 'OPERATOR_INPUT'; message: string }
  | { type: 'SWEEP_DUE' }
  | { type: 'QUEUE_EMPTY' };

// --- Adapter Interfaces ---

export interface ClaudeAdapter {
  write(prompt: string, scope: TaskScope): Promise<Result<string>>;
  fix(errors: string): Promise<Result<string>>;
  chat(message: string): Promise<Result<string>>;
  cleanup(): Promise<Result<string>>;
}

export interface CodexAdapter {
  review(request: ReviewRequest): Promise<Result<ReviewResult>>;
}

export interface GitAdapter {
  createBranch(name: string): Promise<Result<BranchState>>;
  commit(message: string): Promise<Result<string>>;
  getDiff(base?: string): Promise<Result<string>>;
  merge(branch: string): Promise<Result<void>>;
  rebaseAll(except: string): Promise<Result<void>>;
  currentBranch(): Promise<Result<string>>;
}

export interface NotifierAdapter {
  send(notification: Notification): Promise<Result<void>>;
}

export interface TaskQueueAdapter {
  next(): Promise<Result<TaskDefinition | null>>;
  markDone(taskId: string): Promise<Result<void>>;
  markStuck(taskId: string, reason: string): Promise<Result<void>>;
  add(task: Omit<TaskDefinition, 'id' | 'createdAt'>): Promise<Result<TaskDefinition>>;
  list(): Promise<Result<TaskState[]>>;
}
