import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { runTask } from '../task-runner.js';
import { err, ok } from '../../shared/result.js';

const repo = async () => {
  const path = await mkdtemp(join(tmpdir(), 'agentloop-task-runner-'));
  await mkdir(join(path, 'src'), { recursive: true });
  await writeFile(join(path, 'verify.sh'), '#!/usr/bin/env bash\nexit 0\n', 'utf-8');
  await chmod(join(path, 'verify.sh'), 0o755);
  return path;
};
const task = { id: 'task-1', title: 'Define result type', description: 'Create shared result helpers.', type: 'implement' as const, scope: { editableFiles: ['src/result.ts'], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: ['verify passes'], priority: 'medium' as const, createdAt: '2026-03-31T00:00:00.000Z' };

test('skips review adapters when review is disabled', async () => {
  const cwd = await repo();
  const codexReview = jest.fn(async () => ok({ reviewer: 'codex-detail' as const, findings: [], duration: 0, rawOutput: 'clean' }));
  const claudeReview = jest.fn(async () => ok({ reviewer: 'opus-bigpicture' as const, findings: [], duration: 0, rawOutput: 'clean' }));
  const result = await runTask({
    config: { repoPath: cwd, verifyCommand: './verify.sh', baseBranch: 'main', reviewEnabled: false, useCodexWriter: true } as never,
    claude: { review: claudeReview } as never, codex: { review: codexReview } as never,
    codexWriter: { write: async () => ok({ text: 'wrote', changedFiles: ['src/result.ts'], tokenEstimate: 1 }), fix: async () => ok({ text: 'fixed', changedFiles: ['src/result.ts'], tokenEstimate: 1 }) },
    git: { commit: async () => ok('commit-1'), checkoutBase: async () => ok(cwd), merge: async () => ok('merge-1'), rebaseAll: async () => ok(undefined) } as never,
    queue: { updateProgress: async () => ok(undefined), updateStatus: async () => ok(undefined), beginFinalization: async () => ok(undefined), renewClaim: async () => ok(undefined) } as never,
    notifier: {} as never,
  } as never, task, 'al/task-1', 'main', cwd, undefined, 'claim-token', undefined, { session: undefined, tokens: 0 }, false);
  expect(result.ok).toBe(true);
  expect(codexReview).not.toHaveBeenCalled();
  expect(claudeReview).not.toHaveBeenCalled();
});

test('fails initial write when codex and claude both change no files', async () => {
  const cwd = await repo();
  const startSession = jest.fn(async () => ok({ id: 'claude-1', taskId: 'task-2' }));
  const result = await runTask({
    config: { repoPath: cwd, verifyCommand: './verify.sh', baseBranch: 'main', reviewEnabled: false, useCodexWriter: true } as never,
    claude: { startSession, waitForStop: async () => ok({ text: 'claude', changedFiles: [], tokenEstimate: 1 }) } as never,
    codex: {} as never, codexWriter: { write: async () => ok({ text: 'done', changedFiles: [], tokenEstimate: 1 }), fix: async () => ok({ text: 'still done', changedFiles: [], tokenEstimate: 1 }) },
    git: { revertFiles: async () => ok(undefined) } as never,
    queue: { updateProgress: async () => ok(undefined), updateStatus: async () => ok(undefined), beginFinalization: async () => ok(undefined), renewClaim: async () => ok(undefined) } as never,
    notifier: {} as never,
  } as never, task, 'al/task-2', 'main', cwd, undefined, 'claim-token', undefined, { session: undefined, tokens: 0 }, false);
  expect(startSession).toHaveBeenCalled();
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'EMPTY_RESPONSE' }) });
  const scope = JSON.parse(await readFile(join(cwd, '.agentloop', 'current-scope.json'), 'utf-8')) as Record<string, unknown>;
  expect(scope).toEqual(expect.objectContaining({ version: 1, taskId: task.id, phase: 'write' }));
});

test('retries initial write once after a transient claude timeout', async () => {
  const cwd = await repo();
  let waits = 0, reverts = 0;
  const result = await runTask({
    config: { repoPath: cwd, verifyCommand: './verify.sh', baseBranch: 'main', reviewEnabled: false, useCodexWriter: true } as never,
    claude: {
      startSession: async () => ok({ id: `claude-${waits}`, taskId: 'task-3' }),
      waitForStop: async () => ++waits === 1 ? err('BUDGET_EXCEEDED', 'Claude write timed out after 180s') : ok({ text: 'done', changedFiles: ['src/result.ts'], tokenEstimate: 1 }),
    } as never,
    codex: {} as never,
    codexWriter: { write: async () => ok({ text: 'noop', changedFiles: [], tokenEstimate: 1 }), fix: async () => ok({ text: 'noop', changedFiles: [], tokenEstimate: 1 }) },
    git: { revertFiles: async () => (reverts += 1, ok(undefined)), commit: async () => ok('commit-1'), checkoutBase: async () => ok(cwd), merge: async () => ok('merge-1'), rebaseAll: async () => ok(undefined) } as never,
    queue: { updateProgress: async () => ok(undefined), updateStatus: async () => ok(undefined), beginFinalization: async () => ok(undefined), renewClaim: async () => ok(undefined) } as never,
    notifier: {} as never,
  } as never, task, 'al/task-3', 'main', cwd, undefined, 'claim-token', undefined, { session: undefined, tokens: 0 }, false);
  expect(result.ok).toBe(true);
  expect(waits).toBe(2);
  expect(reverts).toBe(1);
});

test('skips cleanup verify loop when cleanup changes no files', async () => {
  const cwd = await repo();
  const statuses: string[] = [];
  const result = await runTask({
    config: { repoPath: cwd, verifyCommand: './verify.sh', baseBranch: 'main', reviewEnabled: false, useCodexWriter: true } as never,
    claude: {} as never, codex: {} as never,
    codexWriter: { write: async () => ok({ text: 'wrote', changedFiles: ['src/result.ts'], tokenEstimate: 1 }), fix: async () => ok({ text: 'clean', changedFiles: [], tokenEstimate: 1 }) },
    git: { commit: async () => ok('commit-1'), checkoutBase: async () => ok(cwd), merge: async () => ok('merge-1'), rebaseAll: async () => ok(undefined) } as never,
    queue: {
      updateProgress: async () => ok(undefined),
      updateStatus: async (_id: string, status: string) => (statuses.push(status), ok(undefined)),
      beginFinalization: async () => ok(undefined),
      renewClaim: async () => ok(undefined),
    } as never,
    notifier: {} as never,
  } as never, task, 'al/task-4', 'main', cwd, undefined, 'claim-token', undefined, { session: undefined, tokens: 0 }, false);
  expect(result.ok).toBe(true);
  expect(statuses).toEqual(['verifying', 'cleanup', 'merging']);
});

test('keeps initial non-retryable write failures non-retryable', async () => {
  const cwd = await repo(), revertFiles = jest.fn(async () => ok(undefined));
  const result = await runTask({
    config: { repoPath: cwd, verifyCommand: './verify.sh', baseBranch: 'main', reviewEnabled: false, useCodexWriter: false, claudeRetryDelayMs: 0 } as never,
    claude: { startSession: async () => err('TRANSPORT_ERROR', 'permanent write failure') } as never,
    codex: {} as never, codexWriter: {} as never, git: { revertFiles } as never,
    queue: { updateProgress: async () => ok(undefined), updateStatus: async () => ok(undefined), beginFinalization: async () => ok(undefined), renewClaim: async () => ok(undefined) } as never,
    notifier: {} as never,
  } as never, task, 'al/task-5', 'main', cwd, undefined, 'claim-token', undefined, { session: undefined, tokens: 0 }, false);
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'TRANSPORT_ERROR', message: 'permanent write failure' }) });
  expect(revertFiles).not.toHaveBeenCalled();
});
