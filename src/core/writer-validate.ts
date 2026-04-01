import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type OrchestratorError, type Result } from '../shared/result.js';
import { writeStderr } from '../shared/stderr.js';
import type { TaskDefinition, WriterOutput } from '../types/index.js';
import { checkScope } from './scope.js';
import type { WriterDeps } from './writer.js';

const scratch = (file: string) => /\.bak\d*$|\.tsbuildinfo$/.test(file);
const testFile = (file: string) => /\.test\.[cm]?[jt]sx?$/.test(file);
const codeFile = (file: string) => /\.[cm]?[jt]sx?$/.test(file);
const commented = /^\s*\/\/\s*(const|let|var|function|class|if|for|while|switch|return|import|export|[A-Za-z0-9_$]+\s*[({=])/m;
const errorResult = <T>(error: OrchestratorError): Result<T> => err(error.code, error.message, error.details);

async function placeholderFiles(cwd: string, files: string[]): Promise<string[]> {
  const flagged: string[] = [];
  for (const file of files.filter(file => codeFile(file) && !scratch(file))) try {
    const body = await readFile(join(cwd, file), 'utf-8');
    if (body.trim().length === 0 || /NOT_IMPLEMENTED/.test(body) || commented.test(body) || testFile(file) && !/\b(?:it|test)\s*\(/.test(body)) flagged.push(file);
  } catch {}
  return flagged;
}

async function enforceScope(d: WriterDeps, task: TaskDefinition, cwd: string, output: WriterOutput): Promise<Result<WriterOutput>> {
  if (!d.config.useCodexWriter) return ok(output);
  const removed = output.changedFiles.filter(scratch), changedFiles = output.changedFiles.filter(file => !removed.includes(file));
  if (removed.length > 0) {
    const reverted = await d.git.revertFiles(removed, cwd);
    if (!reverted.ok) return errorResult(reverted.error);
  }
  const scoped = checkScope(changedFiles.join('\n'), task.scope);
  if (!scoped.ok) return errorResult(scoped.error);
  if (scoped.value.length === 0) return ok({ ...output, changedFiles });
  const reverted = await d.git.revertFiles(scoped.value, cwd);
  if (!reverted.ok) return errorResult(reverted.error);
  const kept = changedFiles.filter(file => !scoped.value.includes(file));
  writeStderr(`Codex writer reverted out-of-scope files: ${scoped.value.join(', ')}`);
  return kept.length === 0 ? err('EMPTY_RESPONSE', `Agent only changed out-of-scope files: ${scoped.value.join(', ')}`) : ok({ ...output, changedFiles: kept });
}

export async function enforceWriterOutput(
  d: WriterDeps,
  task: TaskDefinition,
  cwd: string,
  result: Result<WriterOutput>,
  allowNoop = false,
): Promise<Result<WriterOutput>> {
  if (!result.ok) return result;
  const scoped = await enforceScope(d, task, cwd, result.value);
  if (!scoped.ok || allowNoop) return scoped;
  if (scoped.value.changedFiles.length === 0) return err('EMPTY_RESPONSE', 'Agent returned empty output and changed no files');
  const placeholders = await placeholderFiles(cwd, scoped.value.changedFiles);
  return placeholders.length > 0 ? err('EMPTY_RESPONSE', `Agent left placeholder edits in ${placeholders.join(', ')}`) : scoped;
}
