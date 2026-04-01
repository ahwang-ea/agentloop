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
  shotgunAgents: 1,
  maxTasksPerSession: 3,
  maxTokensPerSession: 100000,
  parallelVerify: true,
  sweepInterval: 10,
};

const fail = (path: string, message: string) => err('CONFIG_ERROR', `Cannot load config ${path}: ${message}`);
const isInt = (value: number) => Number.isInteger(value);
const isNonEmpty = (value: string) => value.trim().length > 0;
const readString = (value: unknown) => value == null ? undefined : asString(value);
const readNumber = (value: unknown) => value == null ? undefined : asNumber(value);
const readBoolean = (value: unknown) => value == null ? undefined : asBoolean(value);
const ensureString = (path: string, field: string, value: unknown, required = false) => {
  const parsed = readString(value);
  if (value != null && parsed == null) return fail(path, `${field} must be a string`);
  if (required && parsed != null && !isNonEmpty(parsed)) return fail(path, `${field} must not be empty`);
  return ok(parsed);
};
const ensureBoolean = (path: string, field: string, value: unknown) => {
  const parsed = readBoolean(value);
  return value != null && parsed == null ? fail(path, `${field} must be a boolean`) : ok(parsed);
};
const ensureInteger = (path: string, field: string, value: unknown, min: number) => {
  const parsed = readNumber(value);
  if (value != null && parsed == null) return fail(path, `${field} must be a number`);
  if (parsed != null && (!isInt(parsed) || parsed < min)) return fail(path, `${field} must be an integer >= ${min}`);
  return ok(parsed);
};
const ensureNumber = (path: string, field: string, value: unknown, min: number) => {
  const parsed = readNumber(value);
  if (value != null && parsed == null) return fail(path, `${field} must be a number`);
  if (parsed != null && parsed < min) return fail(path, `${field} must be >= ${min}`);
  return ok(parsed);
};

export async function loadConfig(path?: string): Promise<Result<AgentloopConfig>> {
  if (!path) return ok(DEFAULT_CONFIG);
  try {
    const parsed = parseJson(await readFile(path, 'utf-8'), path);
    if (!parsed.ok) return fail(path, parsed.error.message);
    const raw = asObject(parsed.value);
    if (!raw) return fail(path, 'config must be an object');
    const convergence = raw.convergence == null ? {} : asObject(raw.convergence);
    if (raw.convergence != null && !convergence) return fail(path, 'convergence must be an object');

    for (const field of ['repoPath', 'baseBranch', 'branchPrefix', 'worktreeRoot', 'verifyCommand', 'integrationTestCommand', 'agentsMdPath', 'claudeModel', 'codexModel', 'slackWebhookUrl', 'taskFilePath', 'linearApiKey', 'linearTeamId'] as const) {
      const checked = ensureString(path, field, raw[field], ['verifyCommand', 'agentsMdPath', 'repoPath', 'baseBranch', 'branchPrefix', 'worktreeRoot', 'claudeModel', 'codexModel', 'taskFilePath', 'linearApiKey', 'linearTeamId'].includes(field));
      if (!checked.ok) return checked;
    }
    if (raw.architectureMdPath !== undefined && raw.architectureMdPath !== null) {
      const checked = ensureString(path, 'architectureMdPath', raw.architectureMdPath, true);
      if (!checked.ok) return checked;
    }
    for (const field of ['codexEnabled', 'useCodexWriter', 'autoApproveResearch', 'autoApproveFeatures', 'reviewEnabled', 'readmeTasksEnabled', 'parallelVerify'] as const) {
      const checked = ensureBoolean(path, field, raw[field]);
      if (!checked.ok) return checked;
    }
    for (const [field, min] of [['maxParallelAgents', 1], ['shotgunAgents', 1], ['maxTasksPerSession', 1], ['maxTokensPerSession', 1], ['sweepInterval', 0]] as const) {
      const checked = ensureInteger(path, field, raw[field], min);
      if (!checked.ok) return checked;
    }
    if (raw.taskSource != null && raw.taskSource !== 'file' && raw.taskSource !== 'linear') return fail(path, 'taskSource must be file or linear');
    if (convergence) {
      for (const [field, min] of [['maxWallClock', 1], ['maxTokens', 1], ['stuckThreshold', 1]] as const) {
        const checked = ensureInteger(path, `convergence.${field}`, convergence[field], min);
        if (!checked.ok) return checked;
      }
      const ratio = ensureNumber(path, 'convergence.thrashOverlapRatio', convergence.thrashOverlapRatio, 0);
      if (!ratio.ok) return ratio;
    }

    const taskSource = raw.taskSource ?? DEFAULT_CONFIG.taskSource;
    const parallelVerify = readBoolean(raw.parallelVerify);
    if (parallelVerify === false) return fail(path, 'parallelVerify cannot be false; tests must run in parallel');
    if (taskSource === 'linear' && !isNonEmpty(readString(raw.linearApiKey) ?? '')) return fail(path, 'linearApiKey must be set when taskSource=linear');
    if (taskSource === 'linear' && !isNonEmpty(readString(raw.linearTeamId) ?? '')) return fail(path, 'linearTeamId must be set when taskSource=linear');

    return ok({
      ...DEFAULT_CONFIG,
      ...raw,
      architectureMdPath: raw.architectureMdPath === null ? undefined : (readString(raw.architectureMdPath) ?? DEFAULT_CONFIG.architectureMdPath),
      parallelVerify: parallelVerify ?? DEFAULT_CONFIG.parallelVerify,
      convergence: {
        ...DEFAULT_CONFIG.convergence,
        ...(convergence ? {
          maxWallClock: readNumber(convergence.maxWallClock) ?? DEFAULT_CONFIG.convergence.maxWallClock,
          maxTokens: readNumber(convergence.maxTokens) ?? DEFAULT_CONFIG.convergence.maxTokens,
          stuckThreshold: readNumber(convergence.stuckThreshold) ?? DEFAULT_CONFIG.convergence.stuckThreshold,
          thrashOverlapRatio: readNumber(convergence.thrashOverlapRatio) ?? DEFAULT_CONFIG.convergence.thrashOverlapRatio,
        } : {}),
      },
    });
  } catch (e) {
    return fail(path, e instanceof Error ? e.message : 'unknown error');
  }
}
