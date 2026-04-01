import { err, type Result } from '../shared/result.js';
import type { AgentloopConfig, ClaudeAdapter, ClaudeSession, CodexWriterAdapter, GitAdapter, TaskDefinition, WriterOutput } from '../types/index.js';
import { buildTaskPrompt, codexFailurePrompt, packStartedWrite, runCodexCleanup, runCodexFix, startClaudeWrite, startCodexWrite } from './writer-flow.js';
import { createNote, fallbackNote, retryNote } from './writer-retry.js';
import { enforceWriterOutput } from './writer-validate.js';

export interface WriterDeps { claude: ClaudeAdapter; codexWriter: CodexWriterAdapter; git: GitAdapter; config: Pick<AgentloopConfig, 'repoPath' | 'useCodexWriter'> & { claudeRetryDelayMs?: number }; }
export interface StartedWrite { session?: ClaudeSession; output: WriterOutput; }

const codexFixFailurePrompt = (prompt: string, message: string) => `${prompt}\n\nPrevious Codex fix attempt failed: ${message}\n${retryNote}\n${createNote}\n${fallbackNote}`;

export async function startWrite(d: WriterDeps, task: TaskDefinition, cwd: string, warmSession?: ClaudeSession): Promise<Result<StartedWrite>> {
  const prompt = await buildTaskPrompt(d.config.repoPath, cwd, task);
  if (!d.config.useCodexWriter) return startClaudeWrite(d, task, cwd, warmSession, prompt);
  const output = await startCodexWrite(d, task, cwd, prompt);
  if (output.ok) return packStartedWrite(output);
  return startClaudeWrite(d, task, cwd, warmSession, codexFailurePrompt(prompt, output.error.message));
}
export async function runWriterFix(d: WriterDeps, session: ClaudeSession | undefined, task: TaskDefinition, prompt: string, cwd: string): Promise<Result<WriterOutput>> {
  if (!d.config.useCodexWriter) return session ? enforceWriterOutput(d, task, cwd, await d.claude.fix(session, prompt)) : err('SESSION_ERROR', 'Missing Claude session for fix');
  const output = await runCodexFix(d, session, task, prompt, cwd);
  if (output.ok || output.error.code !== 'CONFIG_ERROR' || !session) return output;
  return enforceWriterOutput(d, task, cwd, await d.claude.fix(session, codexFixFailurePrompt(prompt, output.error.message)));
}
export async function runWriterCleanup(d: WriterDeps, session: ClaudeSession | undefined, task: TaskDefinition, cwd: string): Promise<Result<WriterOutput>> {
  if (!d.config.useCodexWriter) return session ? enforceWriterOutput(d, task, cwd, await d.claude.cleanup(session), true) : err('SESSION_ERROR', 'Missing Claude session for cleanup');
  const output = await runCodexCleanup(d, session, task, cwd);
  if (output.ok || output.error.code !== 'CONFIG_ERROR' || !session) return output;
  return enforceWriterOutput(d, task, cwd, await d.claude.cleanup(session), true);
}
