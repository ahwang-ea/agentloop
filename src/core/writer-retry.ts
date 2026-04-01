import { err, ok, type OrchestratorError, type Result } from '../shared/result.js';
import type { ClaudeSession, TaskDefinition, WriterOutput } from '../types/index.js';
import { enforceWriterOutput } from './writer-validate.js';
import type { StartedWrite, WriterDeps } from './writer.js';

export const retryNote = 'You changed no files. Create or edit the required files now. Do not stop with only an explanation.';
export const createNote = 'If an editable path is a glob or points to a missing file, create the matching in-scope directories and files now.';
export const fallbackNote = 'Do not leave placeholder stubs, placeholder error returns, or empty test files. If you create a test file, include at least one real test.';

const errorResult = <T>(error: OrchestratorError): Result<T> => err(error.code, error.message, error.details);

export const packStartedWrite = (result: Result<WriterOutput>, session?: ClaudeSession): Result<StartedWrite> => {
  if (result.ok) return ok({ session, output: result.value });
  return errorResult(result.error);
};
export const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const retryDelayMs = (d: WriterDeps) => Math.max(0, d.config.claudeRetryDelayMs ?? 3000);
export const codexFailurePrompt = (prompt: string, message: string) => `${prompt}\n\nPrevious Codex attempt failed: ${message}\n${retryNote}\n${createNote}\n${fallbackNote}`;

export async function retryNoop(
  d: WriterDeps,
  task: TaskDefinition,
  cwd: string,
  prompt: string,
  result: Result<WriterOutput>,
  retry: (prompt: string, cwd: string) => Promise<Result<WriterOutput>>,
  allowNoop = false,
): Promise<Result<WriterOutput>> {
  let noFiles = false, note = retryNote;
  if (result.ok) noFiles = result.value.changedFiles.length === 0;
  else {
    noFiles = result.error.code === 'EMPTY_RESPONSE';
    note = `Previous attempt failed: ${result.error.message}`;
  }
  if (allowNoop || !d.config.useCodexWriter || !noFiles) return result;
  return enforceWriterOutput(d, task, cwd, await retry(`${prompt}\n\n${note}\n${retryNote}\n${createNote}`, cwd));
}
