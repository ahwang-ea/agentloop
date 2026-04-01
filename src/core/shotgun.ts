import { err, ok, type Result } from '../shared/result.js';
import type { ConvergenceState, GitAdapter, TaskDefinition, TaskQueueAdapter } from '../types/index.js';
import type { Deps } from '../orchestrator.js';
import { withLease } from './lease.js';
import { newTaskUsage } from './session-budget.js';
import { runTask } from './task-runner.js';
import { mergeCommittedBranch } from './task-merge.js';
import { progressiveVerify } from './verifier.js';

interface Candidate { index: number; branch: string; cwd: string; task: TaskDefinition; }
interface Attempt { candidate: Candidate; promise: Promise<Result<void>>; }
interface ShotgunFailure { candidate: Candidate; error: { code: string; message: string; details?: Record<string, unknown> }; }
type CandidateSelection =
  | { kind: 'winner'; winner: Candidate; attempts: Attempt[] }
  | { kind: 'fallback'; best: Candidate; attempts: Attempt[]; failures: ShotgunFailure[] };

const variantNote = (index: number) => index % 3 === 2 ? 'Variation: write tests first, then implement until they pass.'
  : index % 3 === 0 ? 'Variation: find the closest existing file, copy its pattern, and adapt it.' : '';
const variantTask = (task: TaskDefinition, index: number): TaskDefinition => ({ ...task, id: `${task.id}-shot-${index}`, description: [task.description, variantNote(index)].filter(Boolean).join('\n\n') });
const emptyConvergence = (): ConvergenceState => ({ rounds: [], classification: 'unknown', webSearchTriggered: false, reviewFindings: 0, errorTypes: [], changedFiles: [] });
const preserveBranch = (code: string) => ['STUCK', 'THRASHING', 'REVIEW_CONFLICT', 'REVIEW_STUCK'].includes(code);

function noopQueue(): TaskQueueAdapter {
  const pass = async () => ok(undefined);
  return { renewClaim: pass, updateStatus: pass, updateProgress: pass, beginFinalization: pass, updateFinalization: pass, markDone: pass, markStuck: pass, markQueuedStuck: pass, markBlocked: pass, requeueBlocked: pass, approveBlocked: pass, releaseClaim: pass, add: async () => err('CONFIG_ERROR', 'noop queue add unavailable'), ensureTask: async () => err('CONFIG_ERROR', 'noop queue ensure unavailable'), countByDedupePrefix: async () => ok(0), claimNextActionable: async () => ok(null), list: async () => ok([]) } as TaskQueueAdapter;
}

const fakeGit = (d: Deps): GitAdapter => ({ ...d.git, checkoutBase: async () => ok(d.config.repoPath), merge: async () => ok('shotgun-merge') });
const failureInfo = (failure: unknown): ShotgunFailure['error'] => (
  failure && typeof failure === 'object' && 'code' in failure && 'message' in failure
    ? { code: String((failure as { code: unknown }).code), message: String((failure as { message: unknown }).message), details: (failure as { details?: Record<string, unknown> }).details }
    : { code: 'UNKNOWN', message: failure instanceof Error ? failure.message : 'Shotgun candidate failed' }
);
const shotgunFailures = (error: unknown, attempts: Attempt[]): ShotgunFailure[] => (
  error instanceof AggregateError && Array.isArray(error.errors)
    ? error.errors.map((failure, index) => ({ candidate: attempts[index]?.candidate ?? attempts[0]!.candidate, error: failureInfo(failure) }))
    : attempts.slice(0, 1).map(attempt => ({ candidate: attempt.candidate, error: failureInfo(error) }))
);
const logFailures = (failures: ShotgunFailure[]) => {
  if (failures.length > 0) console.error(`Shotgun fan-out failed: ${failures.map(({ candidate, error }) => `[${candidate.index}:${candidate.branch}] ${error.code} ${error.message}`).join(' | ')}`);
};
const withFailureDetails = <T>(result: Result<T>, failures: ShotgunFailure[]): Result<T> => (
  result.ok || failures.length === 0
    ? result
    : err(result.error.code, result.error.message, {
      ...(result.error.details ?? {}),
      shotgunFailures: failures.map(({ candidate, error }) => ({ index: candidate.index, branch: candidate.branch, code: error.code, message: error.message })),
    })
);

async function cleanupBranches(d: Deps, branches: string[]): Promise<void> {
  for (const branch of [...new Set(branches.filter(Boolean))]) {
    const removed = await d.git.abandonBranch(branch);
    if (!removed.ok) console.error(removed.error.message);
  }
}

async function noteProgress(
  d: Deps, task: TaskDefinition, branch: string, token: string, seed: ConvergenceState | undefined, winner?: number,
): Promise<Result<void>> {
  const convergence = { ...(seed ?? emptyConvergence()), changedFiles: [...new Set([...(seed?.changedFiles ?? []), ...task.scope.editableFiles])], shotgunWinner: winner };
  return d.queue.updateProgress(task.id, { branch, round: convergence.rounds.length, convergence }, token);
}

async function scoreCandidate(d: Deps, task: TaskDefinition, cwd: string): Promise<number> {
  const verify = await progressiveVerify(d.config, task.scope.editableFiles, cwd, false, task.type);
  return !verify.ok ? Number.MAX_SAFE_INTEGER : verify.value.pass ? 0 : verify.value.errors.length;
}

async function prepareCandidates(d: Deps, task: TaskDefinition, branch: string, mergeInto: string, worktreePath: string, n: number): Promise<Result<Candidate[]>> {
  const candidates: Candidate[] = [{ index: 1, branch, cwd: worktreePath, task: variantTask(task, 1) }];
  for (let index = 2; index <= n; index += 1) {
    const created = await d.git.createBranch(`${branch}-shot-${index}`, mergeInto);
    if (!created.ok) {
      await cleanupBranches(d, candidates.slice(1).map(candidate => candidate.branch));
      return created;
    }
    candidates.push({ index, branch: created.value.name, cwd: created.value.worktreePath, task: variantTask(task, index) });
  }
  return ok(candidates);
}

async function selectCandidate(d: Deps, task: TaskDefinition, token: string, attempts: Attempt[]): Promise<Result<CandidateSelection>> {
  return withLease<CandidateSelection>(async () => {
    try {
      const winner = await Promise.any(attempts.map(item => item.promise.then(result => result.ok ? item.candidate : Promise.reject(result.error))));
      return ok<CandidateSelection>({ kind: 'winner', winner, attempts });
    } catch (error) {
      const failures = shotgunFailures(error, attempts);
      logFailures(failures);
      const settled = await Promise.all(attempts.map(async item => ({ candidate: item.candidate, score: await scoreCandidate(d, task, item.candidate.cwd) })));
      const best = settled.sort((a, b) => a.score - b.score || a.candidate.index - b.candidate.index)[0];
      return ok<CandidateSelection>({ kind: 'fallback', best: best.candidate, attempts, failures });
    }
  }, () => d.queue.renewClaim(task.id, token));
}

export async function shotgunExecute(
  d: Deps, task: TaskDefinition, branch: string, mergeInto: string, worktreePath: string, token: string, n: number, seed?: ConvergenceState,
): Promise<Result<void>> {
  const prepared = await prepareCandidates(d, task, branch, mergeInto, worktreePath, n); if (!prepared.ok) return prepared;
  const deps = { ...d, git: fakeGit(d), queue: noopQueue() };
  const attempts = prepared.value.map(candidate => ({ candidate, promise: runTask(deps, candidate.task, candidate.branch, mergeInto, candidate.cwd, undefined, token, undefined, newTaskUsage(), true) }));
  const selected = await selectCandidate(d, task, token, attempts); if (!selected.ok) return selected;
  if (selected.value.kind === 'winner') {
    const winner = selected.value.winner;
    const progress = await noteProgress(d, task, winner.branch, token, seed, winner.index); if (!progress.ok) return progress;
    const merged = await mergeCommittedBranch(d.git, d.queue, task, winner.branch, mergeInto, token);
    await Promise.allSettled(attempts.map(item => item.promise));
    await cleanupBranches(d, attempts.filter(item => item.candidate.branch !== winner.branch).map(item => item.candidate.branch));
    return merged;
  }
  const { best, failures } = selected.value;
  await cleanupBranches(d, attempts.filter(item => item.candidate.branch !== best.branch).map(item => item.candidate.branch));
  const progress = await noteProgress(d, task, best.branch, token, seed); if (!progress.ok) return withFailureDetails(progress, failures);
  const fallback = await runTask(d, task, best.branch, mergeInto, best.cwd, seed, token, undefined, newTaskUsage(), false);
  if (fallback.ok || preserveBranch(fallback.error.code)) return withFailureDetails(fallback, failures);
  await cleanupBranches(d, [best.branch]);
  return withFailureDetails(fallback, failures);
}
