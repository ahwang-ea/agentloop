// core/deps.ts — Dependency factory for the orchestrator.

import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig } from '../types/index.js';
import type { Deps } from '../orchestrator.js';
import { createClaudeAdapter } from './claude.js';
import { createCodexAdapter } from './codex.js';
import { createCodexWriterAdapter, verifyCodexCli } from './codex-writer.js';
import { createGitAdapter } from './git.js';
import { createNotifierAdapter } from './notifier.js';
import { createFileTaskQueue } from './task-queue.js';

export async function createDeps(config: AgentloopConfig, _interactive: boolean): Promise<Result<Deps>> {
  if (config.taskSource !== 'file') return err('CONFIG_ERROR', 'Only file task queues are implemented');
  if (!process.env.OPENAI_API_KEY) return err('CONFIG_ERROR', 'OPENAI_API_KEY is required for Codex review');
  if (config.useCodexWriter) {
    const verified = await verifyCodexCli();
    if (!verified.ok) return verified;
  }
  return ok({
    config,
    claude: createClaudeAdapter(config),
    codex: createCodexAdapter(process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL ?? config.codexModel),
    codexWriter: createCodexWriterAdapter(config.codexModel),
    git: createGitAdapter(config),
    notifier: createNotifierAdapter(config),
    queue: createFileTaskQueue(config),
  });
}
