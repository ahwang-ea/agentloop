import { join } from 'node:path';
import type { ClaimedActionableTask } from '../types/index.js';
import { ok, err, type Result } from '../shared/result.js';
import type { Deps } from '../orchestrator.js';
import { tryWithArtifactLock } from './artifact-lock.js';
import { findDependencyFailures } from './dependency-deadlock.js';
import { createWorkerState, handleClaim, notify, recordStuck } from './orchestrator-claim.js';
import { architectSweep } from './sweep.js';

interface SharedState { sweepCounter: number; sweep?: Promise<Result<void>>; }

const pending = new Set(['queued', 'writing', 'verifying', 'reviewing', 'fixing', 'cleanup', 'merging', 'finalizing']);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const expired = (deadlineAt?: number) => deadlineAt != null && Date.now() >= deadlineAt;
const sweepLockPath = (repoPath: string) => join(repoPath, '.agentloop', 'architect-sweep');

async function claim(d: Deps): Promise<Result<ClaimedActionableTask | null>> {
  while (true) {
    const claimed = await d.queue.claimNextActionable(d.config.maxParallelAgents);
    if (claimed.ok || claimed.error.code !== 'QUEUE_CORRUPT') return claimed;
    await notify(d, undefined, 'Queue corrupted', claimed.error.message);
    await sleep(1_000);
  }
}

async function runSweep(d: Deps, shared: SharedState): Promise<Result<void>> {
  if (d.config.sweepInterval <= 0) return ok(undefined);
  if (!shared.sweep) shared.sweep = (async () => {
    const result = await tryWithArtifactLock(sweepLockPath(d.config.repoPath), 'architect sweep', async () => architectSweep(d));
    shared.sweep = undefined;
    if (!result.ok) console.error(result.error.message);
    return ok(undefined);
  })();
  return shared.sweep;
}

async function waitForWork(d: Deps, shared: SharedState): Promise<Result<'retry' | 'stop'>> {
  const tasks = await d.queue.list();
  if (!tasks.ok) return tasks;
  const failures = findDependencyFailures(tasks.value);
  for (const failure of failures) {
    const task = tasks.value.find(item => item.task.id === failure.taskId)?.task;
    if (!task) continue;
    const stuck = await d.queue.markQueuedStuck(task.id, failure.reason);
    if (!stuck.ok && !['CONFIG_ERROR', 'QUEUE_EMPTY'].includes(stuck.error.code)) return stuck;
    if (!stuck.ok) continue;
    await recordStuck(d, task, failure.reason);
  }
  const current = failures.length === 0 ? tasks : await d.queue.list();
  if (!current.ok) return current;
  if (current.value.some(task => pending.has(task.status))) { await sleep(250); return ok('retry'); }
  const swept = await runSweep(d, shared);
  if (!swept.ok) return swept;
  const refreshed = await d.queue.list();
  if (!refreshed.ok) return refreshed;
  return ok(refreshed.value.some(task => pending.has(task.status)) ? 'retry' : 'stop');
}

async function maybeSweep(d: Deps, shared: SharedState): Promise<Result<void>> {
  if (d.config.sweepInterval <= 0) return ok(undefined);
  if (++shared.sweepCounter < d.config.sweepInterval) return ok(undefined);
  shared.sweepCounter = 0;
  return runSweep(d, shared);
}

export async function runWorker(d: Deps, shared: SharedState, deadlineAt?: number): Promise<Result<void>> {
  const worker = createWorkerState();
  while (true) {
    if (expired(deadlineAt)) return err('BUDGET_EXCEEDED', 'Benchmark wall-clock limit exceeded');
    const claimed = await claim(d);
    if (!claimed.ok) { await notify(d, undefined, `Queue error: ${claimed.error.code}`, claimed.error.message); return claimed; }
    if (!claimed.value) {
      const next = await waitForWork(d, shared);
      if (!next.ok || next.value === 'stop') return next.ok ? ok(undefined) : next;
      continue;
    }
    const handled = await handleClaim(d, claimed.value, worker);
    if (!handled.ok) return handled;
    if (handled.value) {
      const swept = await maybeSweep(d, shared);
      if (!swept.ok) return swept;
    }
  }
}
