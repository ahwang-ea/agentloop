import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from '../shared/result.js';
import { writeStderr, writeStderrIf } from '../shared/stderr.js';
import type { AgentloopConfig, ClaudeAdapter, ClaudeSession, CodexWriterAdapter, GitAdapter, TaskDefinition, WriterOutput } from '../types/index.js';
import { learningsAddendum } from './learnings.js';
import { checkScope } from './scope.js';
import { buildCleanupPrompt, buildFixPrompt, buildWritePrompt, concreteTargetsOf } from './writer-prompt.js';

export interface WriterDeps { claude: ClaudeAdapter; codexWriter: CodexWriterAdapter; git: GitAdapter; config: Pick<AgentloopConfig, 'repoPath' | 'useCodexWriter'> & { claudeRetryDelayMs?: number }; }
export interface StartedWrite { session?: ClaudeSession; output: WriterOutput; }
const invalid = (output: WriterOutput) => output.changedFiles.length === 0;
const retryNote = 'You changed no files. Create or edit the required files now. Do not stop with only an explanation.';
const createNote = 'If an editable path is a glob or points to a missing file, create the matching in-scope directories and files now.';
const fallbackNote = 'Do not leave placeholder stubs, placeholder error returns, or empty test files. If you create a test file, include at least one real test.';
const scratch = (file: string) => /\.bak\d*$|\.tsbuildinfo$/.test(file);
const testFile = (file: string) => /\.test\.[cm]?[jt]sx?$/.test(file);
const codeFile = (file: string) => /\.[cm]?[jt]sx?$/.test(file);
const commented = /^\s*\/\/\s*(const|let|var|function|class|if|for|while|switch|return|import|export|[A-Za-z0-9_$]+\s*[({=])/m;
const uniq = (items: string[]) => [...new Set(items.filter(Boolean))];
const logWrite = (taskId: string, message: string) => writeStderrIf(process.env.AGENTLOOP_LOG_WRITE === '1' || process.env.AGENTLOOP_LOG_VERIFY === '1', `[write] ${taskId} ${message}`);
const pack = (result: Result<WriterOutput>, session?: ClaudeSession): Result<StartedWrite> => result.ok ? ok({ session, output: result.value }) : err(result.error.code, result.error.message, result.error.details);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const retryDelayMs = (d: WriterDeps) => Math.max(0, d.config.claudeRetryDelayMs ?? 3000);
const targetNames = (task: TaskDefinition) => new Set(concreteTargetsOf(task).map(file => file.split('/').pop() ?? file));
const siblingExamples = async (cwd: string, task: TaskDefinition) => {
  const examples: string[] = [], targets = targetNames(task);
  const dirs = uniq(task.scope.editableFiles.map(file => file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.')).slice(0, 3);
  for (const dir of dirs) try {
    for (const name of (await readdir(join(cwd, dir))).sort()) if (codeFile(name) && !targets.has(name)) examples.push(dir === '.' ? name : `${dir}/${name}`);
  } catch { /* ignore missing dirs */ }
  return uniq(examples).slice(0, 6);
};
const promptOf = async (repoPath: string, cwd: string, task: TaskDefinition) => {
  const prompt = buildWritePrompt(task, await siblingExamples(cwd, task)), learnings = await learningsAddendum({ repoPath }, task);
  return learnings.ok && learnings.value ? `${prompt}\n\n${learnings.value}` : prompt;
};
const fixPromptOf = (cwd: string, task: TaskDefinition, prompt: string) => siblingExamples(cwd, task).then(examples => buildFixPrompt(task, prompt, examples));
const forceCreatePrompt = async (cwd: string, task: TaskDefinition) => [
  buildWritePrompt(task, await siblingExamples(cwd, task)), '',
  concreteTargetsOf(task).length === 0 ? createNote : `Create these exact in-scope files now: ${concreteTargetsOf(task).join(', ')}`,
  'Do not stop until at least one of them exists with real code or tests.',
].join('\n');
const placeholderFiles = async (cwd: string, files: string[]) => {
  const flagged: string[] = [];
  for (const file of files.filter(file => codeFile(file) && !scratch(file))) try {
    const body = await readFile(join(cwd, file), 'utf-8');
    if (body.trim().length === 0 || /NOT_IMPLEMENTED/.test(body) || commented.test(body) || testFile(file) && !/\b(?:it|test)\s*\(/.test(body)) flagged.push(file);
  } catch { /* ignore unreadable files */ }
  return flagged;
};

async function enforceScope(d: WriterDeps, task: TaskDefinition, cwd: string, output: WriterOutput): Promise<Result<WriterOutput>> {
  if (!d.config.useCodexWriter) return ok(output);
  const removed = output.changedFiles.filter(scratch), changedFiles = output.changedFiles.filter(file => !removed.includes(file));
  if (removed.length > 0) { const reverted = await d.git.revertFiles(removed, cwd); if (!reverted.ok) return reverted; }
  const scoped = checkScope(changedFiles.join('\n'), task.scope); if (!scoped.ok) return scoped;
  if (scoped.value.length === 0) return ok({ ...output, changedFiles });
  const reverted = await d.git.revertFiles(scoped.value, cwd); if (!reverted.ok) return reverted;
  const kept = changedFiles.filter(file => !scoped.value.includes(file));
  writeStderr(`Codex writer reverted out-of-scope files: ${scoped.value.join(', ')}`);
  return kept.length === 0 ? err('EMPTY_RESPONSE', `Agent only changed out-of-scope files: ${scoped.value.join(', ')}`) : ok({ ...output, changedFiles: kept });
}
const checked = async (d: WriterDeps, task: TaskDefinition, cwd: string, result: Result<WriterOutput>, allowNoop = false) => {
  if (!result.ok) return result;
  const scoped = await enforceScope(d, task, cwd, result.value);
  if (!scoped.ok || allowNoop) return scoped;
  if (invalid(scoped.value)) return err('EMPTY_RESPONSE', 'Agent returned empty output and changed no files');
  const placeholders = await placeholderFiles(cwd, scoped.value.changedFiles);
  return placeholders.length > 0 ? err('EMPTY_RESPONSE', `Agent left placeholder edits in ${placeholders.join(', ')}`) : scoped;
};
const retryNoop = async (d: WriterDeps, task: TaskDefinition, cwd: string, prompt: string, result: Result<WriterOutput>, retry: (prompt: string, cwd: string) => Promise<Result<WriterOutput>>, allowNoop = false): Promise<Result<WriterOutput>> => {
  const noFiles = result.ok ? result.value.changedFiles.length === 0 : result.error.code === 'EMPTY_RESPONSE';
  if (allowNoop || !d.config.useCodexWriter || !noFiles) return result;
  const note = result.ok ? retryNote : `Previous attempt failed: ${result.error.message}`;
  return checked(d, task, cwd, await retry(`${prompt}\n\n${note}\n${retryNote}\n${createNote}`, cwd));
};
const startCodex = async (d: WriterDeps, task: TaskDefinition, cwd: string, prompt: string) => {
  const output = await retryNoop(d, task, cwd, prompt, await checked(d, task, cwd, await d.codexWriter.write(prompt, cwd)), d.codexWriter.write);
  logWrite(task.id, `codex write ${output.ok ? 'ok' : output.error.code}: ${output.ok ? output.value.changedFiles.join(', ') || '(none)' : output.error.message}`);
  if (output.ok || output.error.code !== 'EMPTY_RESPONSE') return output;
  const fixed = await checked(d, task, cwd, await d.codexWriter.fix(await fixPromptOf(cwd, task, `${output.error.message}\n${retryNote}\n${createNote}`), cwd));
  logWrite(task.id, `codex fix ${fixed.ok ? 'ok' : fixed.error.code}: ${fixed.ok ? fixed.value.changedFiles.join(', ') || '(none)' : fixed.error.message}`);
  if (fixed.ok || fixed.error.code !== 'EMPTY_RESPONSE') return fixed;
  const forced = await checked(d, task, cwd, await d.codexWriter.write(await forceCreatePrompt(cwd, task), cwd));
  logWrite(task.id, `codex force-create ${forced.ok ? 'ok' : forced.error.code}: ${forced.ok ? forced.value.changedFiles.join(', ') || '(none)' : forced.error.message}`);
  return forced;
};
const startClaude = async (d: WriterDeps, task: TaskDefinition, cwd: string, warmSession: ClaudeSession | undefined, prompt: string) => {
  let last: Result<StartedWrite> = err('SESSION_ERROR', 'Claude fallback failed'), nextPrompt = prompt;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = await d.claude.startSession(task, cwd, warmSession, nextPrompt);
    if (!session.ok) last = session;
    else {
      const output = pack(await checked(d, task, cwd, await d.claude.waitForStop(session.value)), session.value);
      logWrite(task.id, `claude write ${output.ok ? 'ok' : output.error.code}: ${output.ok ? output.value.output.changedFiles.join(', ') || '(none)' : output.error.message}`);
      if (output.ok) return output;
      last = output;
      nextPrompt = `${prompt}\n\nPrevious Claude attempt failed: ${output.error.message}\n${retryNote}\n${createNote}\n${fallbackNote}`;
      if (output.error.code === 'BUDGET_EXCEEDED') return output;
    }
    const delay = retryDelayMs(d);
    if (attempt === 0 && delay > 0) await pause(delay);
  }
  return last;
};

export async function startWrite(d: WriterDeps, task: TaskDefinition, cwd: string, warmSession?: ClaudeSession): Promise<Result<StartedWrite>> {
  const prompt = await promptOf(d.config.repoPath, cwd, task);
  if (!d.config.useCodexWriter) return startClaude(d, task, cwd, warmSession, prompt);
  const output = await startCodex(d, task, cwd, prompt);
  if (output.ok) return pack(output);
  if (output.error.code === 'CONFIG_ERROR') return pack(output);
  return startClaude(d, task, cwd, warmSession, `${prompt}\n\nPrevious Codex attempt failed: ${output.error.message}\n${retryNote}\n${createNote}\n${fallbackNote}`);
}
export async function runWriterFix(d: WriterDeps, session: ClaudeSession | undefined, task: TaskDefinition, prompt: string, cwd: string): Promise<Result<WriterOutput>> {
  if (!d.config.useCodexWriter) return session ? checked(d, task, cwd, await d.claude.fix(session, prompt)) : err('SESSION_ERROR', 'Missing Claude session for fix');
  const fixPrompt = await fixPromptOf(cwd, task, prompt);
  const output = await retryNoop(d, task, cwd, fixPrompt, await checked(d, task, cwd, await d.codexWriter.fix(fixPrompt, cwd)), d.codexWriter.fix);
  if (output.ok || !session || output.error.code === 'CONFIG_ERROR') return output;
  return checked(d, task, cwd, await d.claude.fix(session, `${prompt}\n\nPrevious Codex fix attempt failed: ${output.error.message}\n${retryNote}\n${createNote}\n${fallbackNote}`));
}
export async function runWriterCleanup(d: WriterDeps, session: ClaudeSession | undefined, task: TaskDefinition, cwd: string): Promise<Result<WriterOutput>> {
  if (!d.config.useCodexWriter) return session ? checked(d, task, cwd, await d.claude.cleanup(session)) : err('SESSION_ERROR', 'Missing Claude session for cleanup');
  const prompt = await fixPromptOf(cwd, task, buildCleanupPrompt(task));
  return retryNoop(d, task, cwd, prompt, await checked(d, task, cwd, await d.codexWriter.fix(prompt, cwd), true), d.codexWriter.fix, true);
}
