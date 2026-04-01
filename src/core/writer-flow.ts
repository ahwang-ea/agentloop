import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type OrchestratorError, type Result } from '../shared/result.js';
import { writeStderrIf } from '../shared/stderr.js';
import type { ClaudeSession, TaskDefinition, WriterOutput } from '../types/index.js';
import { learningsAddendum } from './learnings.js';
import { buildCleanupPrompt, buildFixPrompt, buildWritePrompt, concreteTargetsOf } from './writer-prompt.js';
import { enforceWriterOutput } from './writer-validate.js';
import type { StartedWrite, WriterDeps } from './writer.js';

export const retryNote = 'You changed no files. Create or edit the required files now. Do not stop with only an explanation.';
export const createNote = 'If an editable path is a glob or points to a missing file, create the matching in-scope directories and files now.';
export const fallbackNote = 'Do not leave placeholder stubs, placeholder error returns, or empty test files. If you create a test file, include at least one real test.';

const codeFile = (file: string) => /\.[cm]?[jt]sx?$/.test(file);
const uniq = (items: string[]) => [...new Set(items.filter(Boolean))];
const logWrite = (taskId: string, message: string) => writeStderrIf(process.env.AGENTLOOP_LOG_WRITE === '1' || process.env.AGENTLOOP_LOG_VERIFY === '1', `[write] ${taskId} ${message}`);
const errorResult = <T>(error: OrchestratorError): Result<T> => err(error.code, error.message, error.details);
const packStartedWrite = (result: Result<WriterOutput>, session?: ClaudeSession): Result<StartedWrite> => {
  if (result.ok) return ok({ session, output: result.value });
  return errorResult(result.error);
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const retryDelayMs = (d: WriterDeps) => Math.max(0, d.config.claudeRetryDelayMs ?? 3000);
const targetNames = (task: TaskDefinition) => new Set(concreteTargetsOf(task).map(file => file.split('/').pop() ?? file));
const codexFailurePrompt = (prompt: string, message: string) => `${prompt}\n\nPrevious Codex attempt failed: ${message}\n${retryNote}\n${createNote}\n${fallbackNote}`;
const logWriterResult = (taskId: string, label: string, result: Result<WriterOutput>) => result.ok
  ? logWrite(taskId, `${label} ok: ${result.value.changedFiles.join(', ') || '(none)'}`)
  : logWrite(taskId, `${label} ${result.error.code}: ${result.error.message}`);
const logStartedWrite = (taskId: string, label: string, result: Result<StartedWrite>) => result.ok
  ? logWrite(taskId, `${label} ok: ${result.value.output.changedFiles.join(', ') || '(none)'}`)
  : logWrite(taskId, `${label} ${result.error.code}: ${result.error.message}`);

async function siblingExamples(cwd: string, task: TaskDefinition): Promise<string[]> {
  const examples: string[] = [], targets = targetNames(task);
  const dirs = uniq(task.scope.editableFiles.map(file => file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.')).slice(0, 3);
  for (const dir of dirs) try {
    for (const name of (await readdir(join(cwd, dir))).sort()) if (codeFile(name) && !targets.has(name)) examples.push(dir === '.' ? name : `${dir}/${name}`);
  } catch {}
  return uniq(examples).slice(0, 6);
}

async function buildTaskFixPrompt(cwd: string, task: TaskDefinition, prompt: string): Promise<string> {
  return buildFixPrompt(task, prompt, await siblingExamples(cwd, task));
}
async function buildForceCreatePrompt(cwd: string, task: TaskDefinition): Promise<string> {
  const targets = concreteTargetsOf(task);
  return [
    buildWritePrompt(task, await siblingExamples(cwd, task)), '',
    targets.length === 0 ? createNote : `Create these exact in-scope files now: ${targets.join(', ')}`,
    'Do not stop until at least one of them exists with real code or tests.',
  ].join('\n');
}
async function retryNoop(
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

export async function buildTaskPrompt(repoPath: string, cwd: string, task: TaskDefinition): Promise<string> {
  const prompt = buildWritePrompt(task, await siblingExamples(cwd, task)), learnings = await learningsAddendum({ repoPath }, task);
  return learnings.ok && learnings.value ? `${prompt}\n\n${learnings.value}` : prompt;
}
export { codexFailurePrompt, packStartedWrite };

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
