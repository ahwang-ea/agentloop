import { readFile } from 'node:fs/promises';
import { ok, err, type Result } from '../shared/result.js';
import type { AgentloopConfig } from '../types/index.js';
import { asBoolean, asNumber, asObject, asString, parseJson } from './persisted-json.js';

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
  useCodexWriter: true,
  autoApproveResearch: false,
  autoApproveFeatures: false,
  reviewEnabled: true,
  readmeTasksEnabled: true,
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
    const parsed = parseJson(await readFile(path, 'utf-8'), path); if (!parsed.ok) return err('CONFIG_ERROR', `Cannot load config ${path}: ${parsed.error.message}`);
    const raw = asObject(parsed.value); if (!raw) return err('CONFIG_ERROR', `Cannot load config ${path}: config must be an object`);
    const convergence = raw.convergence == null ? {} : asObject(raw.convergence);
    if (raw.baseBranch != null && !asString(raw.baseBranch)) return err('CONFIG_ERROR', `Cannot load config ${path}: baseBranch must be a string`);
    if (raw.branchPrefix != null && !asString(raw.branchPrefix)) return err('CONFIG_ERROR', `Cannot load config ${path}: branchPrefix must be a string`);
    if (raw.verifyCommand != null && !asString(raw.verifyCommand)) return err('CONFIG_ERROR', `Cannot load config ${path}: verifyCommand must be a string`);
    if (raw.agentsMdPath != null && !asString(raw.agentsMdPath)) return err('CONFIG_ERROR', `Cannot load config ${path}: agentsMdPath must be a string`);
    if (raw.architectureMdPath !== undefined && raw.architectureMdPath !== null && !asString(raw.architectureMdPath)) return err('CONFIG_ERROR', `Cannot load config ${path}: architectureMdPath must be a string or null`);
    if (raw.codexEnabled != null && asBoolean(raw.codexEnabled) == null) return err('CONFIG_ERROR', `Cannot load config ${path}: codexEnabled must be a boolean`);
    if (raw.maxParallelAgents != null && asNumber(raw.maxParallelAgents) == null) return err('CONFIG_ERROR', `Cannot load config ${path}: maxParallelAgents must be a number`);
    if (raw.sweepInterval != null && asNumber(raw.sweepInterval) == null) return err('CONFIG_ERROR', `Cannot load config ${path}: sweepInterval must be a number`);
    if (raw.taskSource != null && raw.taskSource !== 'file' && raw.taskSource !== 'linear') return err('CONFIG_ERROR', `Cannot load config ${path}: taskSource must be file or linear`);
    if (raw.convergence != null && !convergence) return err('CONFIG_ERROR', `Cannot load config ${path}: convergence must be an object`);
    return ok({
      ...DEFAULT_CONFIG,
      ...raw,
      architectureMdPath: raw.architectureMdPath === null ? undefined : (asString(raw.architectureMdPath) ?? DEFAULT_CONFIG.architectureMdPath),
      convergence: {
        ...DEFAULT_CONFIG.convergence,
        ...(convergence ? {
          maxWallClock: asNumber(convergence.maxWallClock) ?? DEFAULT_CONFIG.convergence.maxWallClock,
          maxTokens: asNumber(convergence.maxTokens) ?? DEFAULT_CONFIG.convergence.maxTokens,
          stuckThreshold: asNumber(convergence.stuckThreshold) ?? DEFAULT_CONFIG.convergence.stuckThreshold,
          thrashOverlapRatio: asNumber(convergence.thrashOverlapRatio) ?? DEFAULT_CONFIG.convergence.thrashOverlapRatio,
        } : {}),
      },
    });
  } catch (e) {
    return err('CONFIG_ERROR', `Cannot load config ${path}: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
}
