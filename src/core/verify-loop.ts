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
} from '../types/index.js';
import { classifyConvergence, trackRound, shouldWebSearch } from './convergence.js';
import { withLease } from './lease.js';
import { recordSessionChanges, recordVerifyErrors } from './metrics.js';
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

const setStatus = (d: VerifyDeps, id: string, s: TaskStatus, token: string) => d.queue.updateStatus(id, s, token);

export async function verifyLoop(
  d: VerifyDeps, session: ClaudeSession | undefined, task: TaskDefinition,
  initTokenEstimate: number, lastChangedFiles: string[], conv: ConvergenceState, t0: number, cwd: string, token: string, usage: TaskUsage,
): Promise<Result<void>> {
  const { convergence: cc } = d.config;
  let lastTokenEstimate = initTokenEstimate, files = lastChangedFiles;
  while (true) {
    const v = await progressiveVerify(d.config, files, cwd, false);
    if (!v.ok) return err('VERIFY_FAILED', v.error.message);
    recordVerifyErrors(conv, v.value.errors);
    trackRound(conv, v.value, lastTokenEstimate);
    const sp = await d.queue.updateProgress(task.id, { round: conv.rounds.length, convergence: conv }, token); if (!sp.ok) return sp;
    if (v.value.pass) return ok(undefined);
    if ((Date.now() - t0) / 1000 > cc.maxWallClock) return err('BUDGET_EXCEEDED', `Wall clock: ${conv.rounds.length} rounds`);
    const tokens = conv.rounds.reduce((sum, round) => sum + round.tokens, 0);
    if (tokens > cc.maxTokens) return err('BUDGET_EXCEEDED', `Tokens: ${tokens}/${cc.maxTokens}`);
    conv.classification = classifyConvergence(conv, cc);
    if (conv.classification === 'stuck') return err('STUCK', `Same errors ${cc.stuckThreshold} rounds`);
    if (conv.classification === 'thrashing') return err('THRASHING', 'Errors oscillating');
    const sf = await setStatus(d, task.id, 'fixing', token); if (!sf.ok) return sf;
    const prompt = shouldWebSearch(conv) && !conv.webSearchTriggered
      ? (conv.webSearchTriggered = true, `Search for these errors, then fix:\n${v.value.errors.map(e => e.message).join('\n')}`)
      : truncateVerifyOutput(v.value.output);
    const fix = await withLease(() => runWriterFix(d, session, task, prompt, cwd), () => d.queue.renewClaim(task.id, token));
    if (!fix.ok) return err(fix.error.code, fix.error.message);
    lastTokenEstimate = fix.value.tokenEstimate;
    files = fix.value.changedFiles;
    addTaskTokens(usage, fix.value.tokenEstimate);
    recordSessionChanges(conv, fix.value.changedFiles);
    const fp = await d.queue.updateProgress(task.id, { round: conv.rounds.length, convergence: conv }, token); if (!fp.ok) return fp;
    const sv = await setStatus(d, task.id, 'verifying', token); if (!sv.ok) return sv;
  }
}
