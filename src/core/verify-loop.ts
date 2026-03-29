// core/verify-loop.ts — Verify/fix loop with convergence tracking.

import { ok, err, type Result } from '../shared/result.js';
import type {
  ConvergenceState, TaskStatus, SessionOutput,
  ClaudeAdapter, ClaudeSession, TaskQueueAdapter, AgentloopConfig,
} from '../types/index.js';
import { classifyConvergence, trackRound, shouldWebSearch } from './convergence.js';
import { withLease } from './lease.js';
import { runVerify } from './verifier.js';

export interface VerifyDeps {
  claude: ClaudeAdapter;
  queue: TaskQueueAdapter;
  config: AgentloopConfig;
}

const chk = (r: Result<SessionOutput>): Result<SessionOutput> =>
  r.ok && !r.value.text.trim() && r.value.changedFiles.length === 0
    ? err('EMPTY_RESPONSE', 'Agent returned empty output and changed no files') : r;

const setStatus = (d: VerifyDeps, id: string, s: TaskStatus, token: string) =>
  d.queue.updateStatus(id, s, token);

export async function verifyLoop(
  d: VerifyDeps, session: ClaudeSession, taskId: string,
  initTokensDelta: number, conv: ConvergenceState, t0: number, token: string,
): Promise<Result<void>> {
  const { convergence: cc } = d.config;
  let lastTokensDelta = initTokensDelta;
  while (true) {
    const v = await runVerify(d.config.verifyCommand);
    if (!v.ok) return err('VERIFY_FAILED', v.error.message);
    trackRound(conv, v.value, lastTokensDelta);
    const sp = await d.queue.updateProgress(taskId, { round: conv.rounds.length, convergence: conv }, token);
    if (!sp.ok) return sp;
    if (v.value.pass) return ok(undefined);
    if ((Date.now() - t0) / 1000 > cc.maxWallClock)
      return err('BUDGET_EXCEEDED', `Wall clock: ${conv.rounds.length} rounds`);
    const tokens = conv.rounds.reduce((s, r) => s + r.tokens, 0);
    if (tokens > cc.maxTokens)
      return err('BUDGET_EXCEEDED', `Tokens: ${tokens}/${cc.maxTokens}`);
    conv.classification = classifyConvergence(conv, cc);
    if (conv.classification === 'stuck')
      return err('STUCK', `Same errors ${cc.stuckThreshold} rounds`);
    if (conv.classification === 'thrashing')
      return err('THRASHING', 'Errors oscillating');
    const sf = await setStatus(d, taskId, 'fixing', token);
    if (!sf.ok) return sf;
    const prompt = shouldWebSearch(conv) && !conv.webSearchTriggered
      ? (conv.webSearchTriggered = true, `Search for these errors, then fix:\n${v.value.errors.map(e => e.message).join('\n')}`)
      : v.value.output;
    const fix = chk(await withLease(
      () => d.claude.fix(session, prompt),
      () => d.queue.renewClaim(taskId, token),
    ));
    if (!fix.ok) return err(fix.error.code, fix.error.message);
    lastTokensDelta = fix.value.tokensDelta;
    const sv = await setStatus(d, taskId, 'verifying', token);
    if (!sv.ok) return sv;
  }
}
