// types/config.ts — Configuration types.

import type { ConvergenceConfig } from './domain.js';

export interface AgentloopConfig {
  repoPath: string;
  baseBranch: string;              // Configurable — not hard-coded to 'main'
  verifyCommand: string;
  agentsMdPath: string;
  architectureMdPath?: string;
  claudeModel: string;
  codexModel: string;
  codexEnabled: boolean;
  convergence: ConvergenceConfig;
  slackWebhookUrl?: string;
  taskSource: 'file' | 'linear';
  taskFilePath?: string;
  linearApiKey?: string;
  linearTeamId?: string;
  maxParallelAgents: number;
  parallelVerify: boolean;
  sweepInterval: number;
}

export interface HookConfig {
  hooks: {
    PostToolUse: HookEntry[];
    PreToolUse: HookEntry[];
    Stop: HookEntry[];
    UserPromptSubmit?: HookEntry[];
  };
}

export interface HookEntry {
  matcher: string;
  hooks: HookHandler[];
}

export interface HookHandler {
  type: 'command' | 'http' | 'prompt' | 'agent';
  command?: string;
  url?: string;
  prompt?: string;
}

export interface InitOptions {
  projectName: string;
  stack: 'typescript' | 'python' | 'mixed';
  goals: string;
}

export interface StartOptions {
  config?: Partial<AgentloopConfig>;
  interactive: boolean;
  dryRun: boolean;
}
