import { readFile } from 'node:fs/promises';
import { ok, err, type Result } from '../shared/result.js';
import type { AgentloopConfig } from '../types/index.js';

export const DEFAULT_CONFIG: AgentloopConfig = {
  repoPath: '.',
  baseBranch: 'main',
  branchPrefix: 'al/',
  worktreeRoot: '~/.agentloop/worktrees',
  verifyCommand: './verify.sh',
  agentsMdPath: 'AGENTS.md',
  architectureMdPath: 'ARCHITECTURE.md',
  claudeModel: 'claude-opus-4-6',
  codexModel: 'gpt-4.1',
  codexEnabled: true,
  useCodexWriter: false,
  convergence: { maxWallClock: 1800, maxTokens: 500000, stuckThreshold: 3, thrashOverlapRatio: 0.5 },
  taskSource: 'file',
  taskFilePath: 'tasks.json',
  maxParallelAgents: 2,
  maxTasksPerSession: 3,
  maxTokensPerSession: 100000,
  parallelVerify: true,
  sweepInterval: 10,
};

export async function loadConfig(path?: string): Promise<Result<AgentloopConfig>> {
  if (!path) return ok(DEFAULT_CONFIG);
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8')) as Partial<AgentloopConfig> & { architectureMdPath?: string | null };
    return ok({
      ...DEFAULT_CONFIG,
      ...raw,
      architectureMdPath: raw.architectureMdPath === null ? undefined : raw.architectureMdPath ?? DEFAULT_CONFIG.architectureMdPath,
      convergence: { ...DEFAULT_CONFIG.convergence, ...raw.convergence },
    });
  } catch (e) {
    return err('CONFIG_ERROR', `Cannot load config ${path}: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
}
