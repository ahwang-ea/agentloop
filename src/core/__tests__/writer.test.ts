import { jest } from '@jest/globals';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWrite, runWriterCleanup } from '../writer.js';
import { err, ok } from '../../shared/result.js';

const task = {
  id: 'task-1',
  title: 'Add db layer',
  description: 'Create the database files.',
  type: 'implement' as const,
  scope: { editableFiles: ['src/db/*.ts'], readOnlyContext: [], forbiddenFiles: [] },
  acceptanceCriteria: ['src/db/index.ts exists'],
  priority: 'medium' as const,
  createdAt: '2026-03-31T00:00:00.000Z',
};
const deps = (write: (prompt: string) => Promise<ReturnType<typeof ok>>) => ({
  config: { repoPath: '.', useCodexWriter: true } as const,
  claude: {} as never,
  git: { trackedFiles: async () => ok([]), revertFiles: async () => ok(undefined) } as never,
  codexWriter: { write: async (prompt: string) => write(prompt), fix: async (prompt: string) => write(prompt) } as never,
});

test('retries codex write when first pass changes no files', async () => {
  let calls = 0;
  const result = await startWrite(deps(async prompt => {
    calls += 1;
    return calls === 1 ? ok({ text: 'done', changedFiles: [], tokenEstimate: 1 }) : ok({ text: prompt, changedFiles: ['src/db/index.ts'], tokenEstimate: 1 });
  }) as never, task, '.');
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(calls).toBe(2);
  expect(result.value.output.changedFiles).toEqual(['src/db/index.ts']);
});

test('cleanup allows a no-op codex response', async () => {
  const result = await runWriterCleanup(deps(async () => ok({ text: 'clean', changedFiles: [], tokenEstimate: 1 })) as never, undefined, task, '.');
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.changedFiles).toEqual([]);
});

test('reverts new out-of-scope files from codex output', async () => {
  jest.spyOn(console, 'warn').mockImplementationOnce(() => {});
  let reverted: string[] = [];
  const result = await startWrite({
    config: { repoPath: '.', useCodexWriter: true },
    claude: {} as never,
    git: {
      trackedFiles: async () => ok([]),
      revertFiles: async (files: string[]) => { reverted = files; return ok(undefined); },
    } as never,
    codexWriter: {
      write: async () => ok({ text: 'done', changedFiles: ['src/db/index.ts', 'src/__tests__/db.test.ts'], tokenEstimate: 1 }),
      fix: async () => ok({ text: 'done', changedFiles: ['src/db/index.ts', 'src/__tests__/db.test.ts'], tokenEstimate: 1 }),
    } as never,
  } as never, task, '.');
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(reverted).toEqual(['src/__tests__/db.test.ts']);
  expect(result.value.output.changedFiles).toEqual(['src/db/index.ts']);
});

test('initial no-op retry uses codex write, not fix', async () => {
  let attempts = 0;
  const write = jest.fn(async (_prompt: string) => ok({ text: 'done', changedFiles: ['src/db/index.ts'], tokenEstimate: 1 }));
  const fix = jest.fn(async (_prompt: string) => ok({ text: 'fixed', changedFiles: ['src/db/other.ts'], tokenEstimate: 1 }));
  const result = await startWrite({
    config: { repoPath: '.', useCodexWriter: true },
    claude: {} as never,
    git: { trackedFiles: async () => ok([]), revertFiles: async () => ok(undefined) } as never,
    codexWriter: {
      write: async (prompt: string) => ++attempts === 1 ? ok({ text: 'noop', changedFiles: [], tokenEstimate: 1 }) : write(prompt),
      fix: async (prompt: string) => fix(prompt),
    } as never,
  } as never, task, '.');
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(write).toHaveBeenCalledTimes(1);
  expect(fix).not.toHaveBeenCalled();
  expect(result.value.output.changedFiles).toEqual(['src/db/index.ts']);
});

test('falls back to claude when codex write stays empty', async () => {
  let started = '';
  const result = await startWrite({
    config: { repoPath: '.', useCodexWriter: true },
    claude: {
      startSession: async (_task: unknown, _cwd: string, _warm: unknown, prompt: string) => { started = prompt; return ok({ id: 'claude-1', taskId: 'task-1' }); },
      waitForStop: async () => ok({ text: 'done', changedFiles: ['src/db/index.ts'], tokenEstimate: 1 }),
    } as never,
    git: { trackedFiles: async () => ok([]), revertFiles: async () => ok(undefined) } as never,
    codexWriter: {
      write: async () => ok({ text: 'noop', changedFiles: [], tokenEstimate: 1 }),
      fix: async () => ok({ text: 'noop', changedFiles: [], tokenEstimate: 1 }),
    } as never,
  } as never, task, '.');
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(started).toContain('You changed no files');
  expect(started).toContain('Do not leave placeholder stubs');
  expect(result.value.session?.id).toBe('claude-1');
  expect(result.value.output.changedFiles).toEqual(['src/db/index.ts']);
});

test('falls back to claude when codex leaves placeholder stubs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentloop-writer-'));
  await mkdir(join(cwd, 'src', 'db'), { recursive: true });
  let started = '';
  const result = await startWrite({
    config: { repoPath: '.', useCodexWriter: true },
    claude: {
      startSession: async (_task: unknown, _cwd: string, _warm: unknown, prompt: string) => { started = prompt; return ok({ id: 'claude-2', taskId: 'task-1' }); },
      waitForStop: async () => { await writeFile(join(cwd, 'src', 'db', 'index.ts'), `export const x = 1;\n`, 'utf-8'); return ok({ text: 'done', changedFiles: ['src/db/index.ts'], tokenEstimate: 1 }); },
    } as never,
    git: { trackedFiles: async () => ok([]), revertFiles: async () => ok(undefined) } as never,
    codexWriter: {
      write: async () => {
        await writeFile(join(cwd, 'src', 'db', 'index.ts'), `export const x = { code: 'NOT_IMPLEMENTED' };\n`, 'utf-8');
        return ok({ text: 'done', changedFiles: ['src/db/index.ts'], tokenEstimate: 1 });
      },
      fix: async () => ok({ text: 'noop', changedFiles: [], tokenEstimate: 1 }),
    } as never,
  } as never, task, cwd);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(started).toContain('Do not leave placeholder stubs');
  expect(result.value.session?.id).toBe('claude-2');
});

test('retries claude fallback once after a transient failure', async () => {
  let waits = 0;
  const result = await startWrite({
    config: { repoPath: '.', useCodexWriter: true, claudeRetryDelayMs: 0 },
    claude: {
      startSession: async () => ok({ id: 'claude-3', taskId: 'task-1' }),
      waitForStop: async () => ++waits === 1 ? err('SESSION_ERROR', 'temporary failure') : ok({ text: 'done', changedFiles: ['src/db/index.ts'], tokenEstimate: 1 }),
    } as never,
    git: { trackedFiles: async () => ok([]), revertFiles: async () => ok(undefined) } as never,
    codexWriter: {
      write: async () => ok({ text: 'noop', changedFiles: [], tokenEstimate: 1 }),
      fix: async () => ok({ text: 'noop', changedFiles: [], tokenEstimate: 1 }),
    } as never,
  } as never, task, '.');
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(waits).toBe(2);
  expect(result.value.session?.id).toBe('claude-3');
});
