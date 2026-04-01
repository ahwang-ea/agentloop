// core/verify-loop.ts — Verify/fix loop with convergence tracking.

import { ok, err, type Result } from '../shared/result.js';
import type {
  AgentloopConfig,
  ClaudeAdapter,
  ClaudeSession,
  CodexWriterAdapter,
  ConvergenceState,
  GitAdapter,
  TaskDefinition,
  TaskQueueAdapter,
  TaskStatus,
  VerifyResult,
} from '../types/index.js';
import { classifyConvergence, trackRound, shouldWebSearch } from './convergence.js';
import { withLease } from './lease.js';
import { recordSessionChanges, recordVerifyErrors } from './metrics.js';
import { elapsedSeconds, flagEnabled, systemRuntime, type RuntimeDeps } from './runtime.js';
import { addTaskTokens, type TaskUsage } from './session-budget.js';
import { progressiveVerify, truncateVerifyOutput } from './verifier.js';
import { runWriterFix, type WriterDeps } from './writer.js';

export interface VerifyDeps extends WriterDeps {
  claude: ClaudeAdapter;
  codexWriter: CodexWriterAdapter;
  git: GitAdapter;
  queue: TaskQueueAdapter;
  config: AgentloopConfig;
}

type LoopRuntime = Pick<RuntimeDeps, 'env' | 'now'>;

const setStatus = (d: VerifyDeps, id: string, s: TaskStatus, token: string) => d.queue.updateStatus(id, s, token);
const shouldLogVerify = (runtime: Pick<RuntimeDeps, 'env'>) => flagEnabled(runtime, 'AGENTLOOP_LOG_VERIFY');
const logVerify = (runtime: LoopRuntime, task: TaskDefinition, round: number, files: string[], pass: boolean, output: string) => {
  if (!shouldLogVerify(runtime)) return;
  const banner = `[verify] ${task.id} round ${round} ${pass ? 'pass' : 'fail'} files=${files.join(', ') || '(none)'}`;
  console.error(banner);
  if (pass) return;
  console.error(truncateVerifyOutput(output));
};
const missingPackages = (verify: VerifyResult) => [...new Set(verify.errors.flatMap(error => {
  const match = error.message.match(/Cannot find module '([^']+)'/);
  return match && !match[1].startsWith('.') && !match[1].startsWith('/') ? [match[1]] : [];
}))];
const rowTypingErrors = (verify: VerifyResult) => verify.errors.some(error => /Argument of type '(?:unknown|\{\})' is not assignable to parameter of type|Property '.+' does not exist on type '\{\}'/.test(error.message));
const resultValueErrors = (verify: VerifyResult) => verify.errors.some(error => /Property 'value' does not exist on type 'Result/.test(error.message));
const verifyFixPrompt = (task: TaskDefinition, verify: VerifyResult) => verify.errors.length === 0 ? truncateVerifyOutput(verify.output) : [
  'Fix these verification errors:',
  ...verify.errors.map(error => `- ${(error.file ?? error.source) + (error.line ? `:${error.line}` : '')}: ${error.message}`),
  ...(missingPackages(verify).length === 0 || task.scope.editableFiles.includes('package.json') ? [] : [
    '',
    `Do not add undeclared packages like ${missingPackages(verify).join(', ')}. Remove or replace those imports using existing repo dependencies, built-in Node APIs, or local code. Do not edit package.json for this task.`,
  ]),
  ...(rowTypingErrors(verify) ? [
    '',
    'Reuse existing row types or mapper helpers from src/db/*.ts before accessing row fields. Do not treat rows as `{}` or `unknown`, and avoid hand-written placeholder objects.',
  ] : []),
  ...(resultValueErrors(verify) ? [
    '',
    'When handling Result<T>, branch on `.ok` before reading `.value`. In tests, assert success first instead of assuming `.value` always exists.',
  ] : []),
  ...(verify.errors.some(error => error.source === 'test') && task.scope.editableFiles.some(file => file.includes('test')) ? [
    '',
    'Fix implementation first. If a task-local test assertion conflicts with actual platform behavior or the task acceptance criteria, correct the test instead of forcing impossible behavior.',
  ] : []),
  '',
  'Focus on the cited files first, then rerun verification.',
  '',
  'Raw verify output:',
  truncateVerifyOutput(verify.output),
].join('\n');

export async function verifyLoop(
  d: VerifyDeps,
  session: ClaudeSession | undefined,
  task: TaskDefinition,
  initTokenEstimate: number,
  lastChangedFiles: string[],
  conv: ConvergenceState,
  t0: number,
  cwd: string,
  token: string,
  usage: TaskUsage,
  runtime: LoopRuntime = systemRuntime,
): Promise<Result<void>> {
  const { convergence: cc } = d.config;
  let lastTokenEstimate = initTokenEstimate, files = lastChangedFiles;
  while (true) {
    const v = await progressiveVerify(d.config, files, cwd, false, task.type, runtime);
    if (!v.ok) return err(v.error.code, v.error.message);
    logVerify(runtime, task, conv.rounds.length + 1, files, v.value.pass, v.value.output);
    recordVerifyErrors(conv, v.value.errors);
    trackRound(conv, v.value, lastTokenEstimate);
    const sp = await d.queue.updateProgress(task.id, { round: conv.rounds.length, convergence: conv }, token); if (!sp.ok) return sp;
    if (v.value.pass) return ok(undefined);
    if (elapsedSeconds(runtime, t0) > cc.maxWallClock) return err('BUDGET_EXCEEDED', `Wall clock: ${conv.rounds.length} rounds`);
    const tokens = conv.rounds.reduce((sum, round) => sum + round.tokens, 0);
    if (tokens > cc.maxTokens) return err('BUDGET_EXCEEDED', `Tokens: ${tokens}/${cc.maxTokens}`);
    conv.classification = classifyConvergence(conv, cc);
    if (conv.classification === 'stuck') return err('STUCK', `Same errors ${cc.stuckThreshold} rounds`);
    if (conv.classification === 'thrashing') return err('THRASHING', 'Errors oscillating');
    const sf = await setStatus(d, task.id, 'fixing', token); if (!sf.ok) return sf;
    const prompt = shouldWebSearch(conv) && !conv.webSearchTriggered
      ? (conv.webSearchTriggered = true, `Search for these errors, then fix:\n${v.value.errors.map(e => e.message).join('\n')}`)
      : verifyFixPrompt(task, v.value);
    const fix = await withLease(() => runWriterFix(d, session, task, prompt, cwd), () => d.queue.renewClaim(task.id, token));
    if (!fix.ok) return err(fix.error.code, fix.error.message);
    lastTokenEstimate = fix.value.tokenEstimate;
    files = fix.value.changedFiles;
    addTaskTokens(usage, fix.value.tokenEstimate);
    recordSessionChanges(conv, fix.value.changedFiles);
    const fp = await d.queue.updateProgress(task.id, { round: conv.rounds.length, convergence: conv }, token); if (!fp.ok) return fp;
  }
}
