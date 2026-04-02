// core/deps.ts — Dependency factory for the orchestrator.

import { ok, type Result } from '../shared/result.js';
import type { AgentloopConfig } from '../types/index.js';
import type { Deps } from '../orchestrator.js';
import { createClaudeAdapter } from './claude.js';
import { createCodexAdapter } from './codex.js';
import { createCodexWriterAdapter } from './codex-writer.js';
import { createGitAdapter } from './git.js';
import { createNotifierAdapter } from './notifier.js';
import { createFileTaskQueue } from './task-queue.js';

export async function createDeps(config: AgentloopConfig, _interactive: boolean): Promise<Result<Deps>> {
  return ok({
    config: { ...config, codexEnabled: config.codexEnabled && Boolean(process.env.OPENAI_API_KEY) },
    claude: createClaudeAdapter(config),
    codex: createCodexAdapter(process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL ?? config.codexModel),
    codexWriter: createCodexWriterAdapter(config.codexModel, config.codexReasoningEffort),
    git: createGitAdapter(config),
    notifier: createNotifierAdapter(config),
    queue: createFileTaskQueue(config),
  });
}
