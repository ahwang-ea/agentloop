import { err, ok, type Result } from '../shared/result.js';
import type {
  AgentloopConfig,
  ClaudeAdapter,
  ClaudeSession,
  CodexWriterAdapter,
  GitAdapter,
  TaskDefinition,
  WriterOutput,
} from '../types/index.js';
import { learningsAddendum } from './learnings.js';
import { checkScope } from './scope.js';
import { buildCleanupPrompt, buildWritePrompt } from './writer-prompt.js';

export interface WriterDeps {
  claude: ClaudeAdapter;
  codexWriter: CodexWriterAdapter;
  git: GitAdapter;
  config: Pick<AgentloopConfig, 'repoPath' | 'useCodexWriter'>;
}
export interface StartedWrite { session?: ClaudeSession; output: WriterOutput; }
const invalid = (output: WriterOutput) => !output.text.trim() && output.changedFiles.length === 0;
const promptOf = async (repoPath: string, task: TaskDefinition) => {
  const learnings = await learningsAddendum({ repoPath }, task);
  return learnings.ok && learnings.value ? `${buildWritePrompt(task)}\n\n${learnings.value}` : buildWritePrompt(task);
};

async function enforceScope(d: WriterDeps, task: TaskDefinition, cwd: string, output: WriterOutput): Promise<Result<WriterOutput>> {
  if (!d.config.useCodexWriter) return ok(output);
  const scoped = checkScope(output.changedFiles.join('\n'), task.scope); if (!scoped.ok) return scoped;
  if (scoped.value.length === 0) return ok(output);
  const reverted = await d.git.revertFiles(scoped.value, cwd); if (!reverted.ok) return reverted;
  console.warn(`Codex writer reverted out-of-scope files: ${scoped.value.join(', ')}`);
  return ok({ ...output, changedFiles: output.changedFiles.filter(file => !scoped.value.includes(file)) });
}
const checked = async (d: WriterDeps, task: TaskDefinition, cwd: string, result: Result<WriterOutput>) => {
  if (!result.ok) return result;
  const scoped = await enforceScope(d, task, cwd, result.value);
  return scoped.ok && invalid(scoped.value) ? err('EMPTY_RESPONSE', 'Agent returned empty output and changed no files') : scoped;
};

export async function startWrite(
  d: WriterDeps, task: TaskDefinition, cwd: string, warmSession?: ClaudeSession,
): Promise<Result<StartedWrite>> {
  const prompt = await promptOf(d.config.repoPath, task);
  if (!d.config.useCodexWriter) {
    const session = await d.claude.startSession(task, cwd, warmSession, prompt); if (!session.ok) return session;
    const output = await checked(d, task, cwd, await d.claude.waitForStop(session.value));
    return output.ok ? ok({ session: session.value, output: output.value }) : output;
  }
  const output = await checked(d, task, cwd, await d.codexWriter.write(prompt, cwd));
  return output.ok ? ok({ output: output.value }) : output;
}
export async function runWriterFix(
  d: WriterDeps, session: ClaudeSession | undefined, task: TaskDefinition, prompt: string, cwd: string,
): Promise<Result<WriterOutput>> {
  return !d.config.useCodexWriter
    ? session ? checked(d, task, cwd, await d.claude.fix(session, prompt)) : err('SESSION_ERROR', 'Missing Claude session for fix')
    : checked(d, task, cwd, await d.codexWriter.fix(prompt, cwd));
}
export async function runWriterCleanup(
  d: WriterDeps, session: ClaudeSession | undefined, task: TaskDefinition, cwd: string,
): Promise<Result<WriterOutput>> {
  return !d.config.useCodexWriter
    ? session ? checked(d, task, cwd, await d.claude.cleanup(session)) : err('SESSION_ERROR', 'Missing Claude session for cleanup')
    : runWriterFix(d, session, task, buildCleanupPrompt(task), cwd);
}
