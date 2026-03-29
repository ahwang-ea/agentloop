// core/task-queue.ts — File-backed task queue adapter with leases.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { ok, err, type Result } from '../shared/result.js';
import type { AgentloopConfig, ClaimedActionableTask, TaskDefinition, TaskQueueAdapter, TaskState } from '../types/index.js';

type Lease = { token: string; expiresAt: string };
type TaskRecord = TaskState & { claim?: Lease; dedupeKey?: string; stuckReason?: string };
const LEASE_MS = 5 * 60_000;
const active = new Set(['writing', 'verifying', 'reviewing', 'fixing', 'cleanup', 'merging']);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const pathOf = (c: AgentloopConfig) => isAbsolute(c.taskFilePath ?? 'tasks.json') ? c.taskFilePath! : join(c.repoPath, c.taskFilePath ?? 'tasks.json');
const expired = (claim?: Lease) => !claim || Date.parse(claim.expiresAt) <= Date.now();
const strip = ({ claim: _c, dedupeKey: _d, stuckReason: _s, ...task }: TaskRecord): TaskState => task;

async function withLock<T>(path: string, run: () => Promise<Result<T>>): Promise<Result<T>> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  for (let i = 0; i < 100; i++) {
    try { await mkdir(lock); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return err('TRANSPORT_ERROR', `Cannot lock ${path}`);
      if (i === 99) return err('SESSION_ERROR', `Timed out waiting for queue lock ${lock}`);
      await sleep(50);
    }
  }
  try { return await run(); } finally { await rm(lock, { recursive: true, force: true }); }
}
async function load(path: string): Promise<Result<TaskRecord[]>> {
  try { return ok(JSON.parse(await readFile(path, 'utf-8')) as TaskRecord[]); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return ok([]);
    if (e instanceof SyntaxError) return err('QUEUE_CORRUPT', `Malformed queue file ${path}`);
    return err('TRANSPORT_ERROR', `Cannot read queue ${path}`);
  }
}
async function save(path: string, tasks: TaskRecord[]): Promise<Result<void>> {
  try {
    await mkdir(join(path, '..'), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(tasks, null, 2));
    await rename(temp, path);
    return ok(undefined);
  } catch { return err('TRANSPORT_ERROR', `Cannot write queue ${path}`); }
}
function lease(): Lease { return { token: randomUUID(), expiresAt: new Date(Date.now() + LEASE_MS).toISOString() }; }
function countActive(tasks: TaskRecord[]): number { return tasks.filter(t => active.has(t.status) && t.claim && !expired(t.claim)).length; }
function withClaim(tasks: TaskRecord[], taskId: string, token: string): Result<TaskRecord> {
  const task = tasks.find(t => t.task.id === taskId);
  return task && task.claim?.token === token && !expired(task.claim) ? ok(task) : err('SESSION_ERROR', `Invalid or expired claim for ${taskId}`);
}

export function createFileTaskQueue(config: AgentloopConfig): TaskQueueAdapter {
  const path = pathOf(config);
  return {
    async claimNextActionable(maxParallelAgents) {
      return withLock<ClaimedActionableTask | null>(path, async () => {
        const tasks = await load(path); if (!tasks.ok) return tasks;
        const records = tasks.value, nextLease = lease(), activeCount = countActive(records);
        const finalizing = records.find(t => t.status === 'finalizing' && expired(t.claim));
        if (finalizing) {
          finalizing.claim = nextLease; const saved = await save(path, records); if (!saved.ok) return saved;
          return ok({ state: { status: 'finalizing', task: finalizing.task, finalization: finalizing.finalization! }, claimToken: nextLease.token });
        }
        if (activeCount >= maxParallelAgents) return ok(null);
        const resumable = records.find(t => active.has(t.status) && expired(t.claim));
        if (resumable) {
          resumable.status = 'writing'; resumable.claim = nextLease;
          const saved = await save(path, records); if (!saved.ok) return saved;
          return ok({ state: { status: 'writing', task: resumable.task, branch: resumable.branch, round: resumable.round, convergence: resumable.convergence }, claimToken: nextLease.token });
        }
        const queued = records.find(t => t.status === 'queued');
        if (!queued) return ok(null);
        queued.status = 'writing'; queued.claim = nextLease; queued.startedAt = new Date().toISOString();
        const saved = await save(path, records); if (!saved.ok) return saved;
        return ok({ state: { status: 'writing', task: queued.task, branch: queued.branch, round: queued.round, convergence: queued.convergence }, claimToken: nextLease.token });
      });
    },
    async renewClaim(taskId, claimToken) { return withLock(path, async () => { const tasks = await load(path); if (!tasks.ok) return tasks; const task = withClaim(tasks.value, taskId, claimToken); if (!task.ok) return task; task.value.claim = lease(); task.value.claim.token = claimToken; return save(path, tasks.value); }); },
    async updateStatus(taskId, status, claimToken) { return withLock(path, async () => { const tasks = await load(path); if (!tasks.ok) return tasks; const task = withClaim(tasks.value, taskId, claimToken); if (!task.ok) return task; task.value.status = status; task.value.claim = { token: claimToken, expiresAt: new Date(Date.now() + LEASE_MS).toISOString() }; return save(path, tasks.value); }); },
    async updateProgress(taskId, progress, claimToken) { return withLock(path, async () => { const tasks = await load(path); if (!tasks.ok) return tasks; const task = withClaim(tasks.value, taskId, claimToken); if (!task.ok) return task; Object.assign(task.value, progress, { claim: { token: claimToken, expiresAt: new Date(Date.now() + LEASE_MS).toISOString() } }); return save(path, tasks.value); }); },
    async beginFinalization(taskId, finalization, claimToken) { return withLock(path, async () => { const tasks = await load(path); if (!tasks.ok) return tasks; const task = withClaim(tasks.value, taskId, claimToken); if (!task.ok) return task; Object.assign(task.value, { status: 'finalizing', finalization, claim: undefined }); return save(path, tasks.value); }); },
    async updateFinalization(taskId, finalization, claimToken) { return withLock(path, async () => { const tasks = await load(path); if (!tasks.ok) return tasks; const task = withClaim(tasks.value, taskId, claimToken); if (!task.ok) return task; task.value.finalization = finalization; task.value.claim = { token: claimToken, expiresAt: new Date(Date.now() + LEASE_MS).toISOString() }; return save(path, tasks.value); }); },
    async markDone(taskId, claimToken) { return withLock(path, async () => { const tasks = await load(path); if (!tasks.ok) return tasks; const task = withClaim(tasks.value, taskId, claimToken); if (!task.ok) return task; Object.assign(task.value, { status: 'done', completedAt: new Date().toISOString(), claim: undefined }); return save(path, tasks.value); }); },
    async markStuck(taskId, reason, claimToken) { return withLock(path, async () => { const tasks = await load(path); if (!tasks.ok) return tasks; const task = withClaim(tasks.value, taskId, claimToken); if (!task.ok) return task; Object.assign(task.value, { status: 'stuck', stuckReason: reason, claim: undefined }); return save(path, tasks.value); }); },
    async markBlocked(taskId, reason, details, claimToken) { return withLock(path, async () => { const tasks = await load(path); if (!tasks.ok) return tasks; const task = withClaim(tasks.value, taskId, claimToken); if (!task.ok) return task; Object.assign(task.value, { status: 'blocked', blocked: { reason, details, blockedAt: new Date().toISOString() }, claim: undefined }); return save(path, tasks.value); }); },
    async requeueBlocked(taskId) { return withLock(path, async () => { const tasks = await load(path); if (!tasks.ok) return tasks; const task = tasks.value.find(t => t.task.id === taskId); if (!task) return err('QUEUE_EMPTY', `Task not found: ${taskId}`); Object.assign(task, { status: 'queued', blocked: undefined, round: 0, convergence: undefined, claim: undefined }); return save(path, tasks.value); }); },
    async releaseClaim(taskId, claimToken) { return withLock(path, async () => { const tasks = await load(path); if (!tasks.ok) return tasks; const task = withClaim(tasks.value, taskId, claimToken); if (!task.ok) return task; task.value.claim = undefined; return save(path, tasks.value); }); },
    async add(task) { return withLock(path, async () => { const tasks = await load(path); if (!tasks.ok) return tasks; const record: TaskRecord = { task: { ...task, id: randomUUID(), createdAt: new Date().toISOString() }, status: 'queued', round: 0, startedAt: new Date().toISOString() }; tasks.value.push(record); const saved = await save(path, tasks.value); return saved.ok ? ok(record.task) : saved; }); },
    async ensureTask(dedupeKey, task) { return withLock(path, async () => { const tasks = await load(path); if (!tasks.ok) return tasks; const existing = tasks.value.find(t => t.dedupeKey === dedupeKey); if (existing) return ok(existing.task); const record: TaskRecord = { task: { ...task, id: randomUUID(), createdAt: new Date().toISOString() }, dedupeKey, status: 'queued', round: 0, startedAt: new Date().toISOString() }; tasks.value.push(record); const saved = await save(path, tasks.value); return saved.ok ? ok(record.task) : saved; }); },
    async list() { const tasks = await load(path); return tasks.ok ? ok(tasks.value.map(strip)) : tasks; },
  };
}
