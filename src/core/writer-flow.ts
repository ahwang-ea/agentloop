import { err, type OrchestratorError, type Result } from '../shared/result.js';
import { writeStderrIf } from '../shared/stderr.js';
import type { ClaudeSession, TaskDefinition, WriterOutput } from '../types/index.js';
import { buildCleanupPrompt } from './writer-prompt.js';
import { buildForceCreatePrompt, buildTaskFixPrompt } from './writer-task-prompt.js';
import { codexFailurePrompt, createNote, fallbackNote, packStartedWrite, pause, retryDelayMs, retryNoop, retryNote } from './writer-retry.js';
import { enforceWriterOutput } from './writer-validate.js';
import type { StartedWrite, WriterDeps } from './writer.js';

const logWrite = (taskId: string, message: string) => writeStderrIf(process.env.AGENTLOOP_LOG_WRITE === '1' || process.env.AGENTLOOP_LOG_VERIFY === '1', `[write] ${taskId} ${message}`);
const errorResult = <T>(error: OrchestratorError): Result<T> => err(error.code, error.message, error.details);
const logWriterResult = (taskId: string, label: string, result: Result<WriterOutput>) => result.ok
  ? logWrite(taskId, `${label} ok: ${result.value.changedFiles.join(', ') || '(none)'}`)
  : logWrite(taskId, `${label} ${result.error.code}: ${result.error.message}`);
const logStartedWrite = (taskId: string, label: string, result: Result<StartedWrite>) => result.ok
  ? logWrite(taskId, `${label} ok: ${result.value.output.changedFiles.join(', ') || '(none)'}`)
  : logWrite(taskId, `${label} ${result.error.code}: ${result.error.message}`);

export { buildTaskPrompt } from './writer-task-prompt.js';
export { codexFailurePrompt, packStartedWrite } from './writer-retry.js';

export async function startCodexWrite(d: WriterDeps, task: TaskDefinition, cwd: string, prompt: string): Promise<Result<WriterOutput>> {
  const output = await retryNoop(d, task, cwd, prompt, await enforceWriterOutput(d, task, cwd, await d.codexWriter.write(prompt, cwd)), d.codexWriter.write);
  logWriterResult(task.id, 'codex write', output);
  if (output.ok) return output;
  if (output.error.code !== 'EMPTY_RESPONSE') return output;
  const fixedPrompt = await buildTaskFixPrompt(cwd, task, `${output.error.message}\n${retryNote}\n${createNote}`);
  const fixed = await enforceWriterOutput(d, task, cwd, await d.codexWriter.fix(fixedPrompt, cwd));
  logWriterResult(task.id, 'codex fix', fixed);
  if (fixed.ok) return fixed;
  if (fixed.error.code !== 'EMPTY_RESPONSE') return fixed;
  const forced = await enforceWriterOutput(d, task, cwd, await d.codexWriter.write(await buildForceCreatePrompt(cwd, task), cwd));
  logWriterResult(task.id, 'codex force-create', forced);
  return forced;
}

export async function startClaudeWrite(d: WriterDeps, task: TaskDefinition, cwd: string, warmSession: ClaudeSession | undefined, prompt: string): Promise<Result<StartedWrite>> {
  let last: Result<StartedWrite> = err('SESSION_ERROR', 'Claude fallback failed'), nextPrompt = prompt;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = await d.claude.startSession(task, cwd, warmSession, nextPrompt);
    if (!session.ok) last = errorResult(session.error);
    else {
      const output = packStartedWrite(await enforceWriterOutput(d, task, cwd, await d.claude.waitForStop(session.value)), session.value);
      logStartedWrite(task.id, 'claude write', output);
      if (output.ok) return output;
      last = output;
      nextPrompt = `${prompt}\n\nPrevious Claude attempt failed: ${output.error.message}\n${retryNote}\n${createNote}\n${fallbackNote}`;
      if (output.error.code === 'BUDGET_EXCEEDED') return output;
    }
    const delay = retryDelayMs(d);
    if (attempt === 0 && delay > 0) await pause(delay);
  }
  return last;
}

export async function runCodexFix(d: WriterDeps, session: ClaudeSession | undefined, task: TaskDefinition, prompt: string, cwd: string): Promise<Result<WriterOutput>> {
  const fixPrompt = await buildTaskFixPrompt(cwd, task, prompt);
  const output = await retryNoop(d, task, cwd, fixPrompt, await enforceWriterOutput(d, task, cwd, await d.codexWriter.fix(fixPrompt, cwd)), d.codexWriter.fix);
  if (output.ok) return output;
  if (!session || output.error.code === 'CONFIG_ERROR') return output;
  return enforceWriterOutput(d, task, cwd, await d.claude.fix(session, `${prompt}\n\nPrevious Codex fix attempt failed: ${output.error.message}\n${retryNote}\n${createNote}\n${fallbackNote}`));
}
export async function runCodexCleanup(d: WriterDeps, task: TaskDefinition, cwd: string): Promise<Result<WriterOutput>> {
  const prompt = await buildTaskFixPrompt(cwd, task, buildCleanupPrompt(task));
  return retryNoop(d, task, cwd, prompt, await enforceWriterOutput(d, task, cwd, await d.codexWriter.fix(prompt, cwd), true), d.codexWriter.fix, true);
}
