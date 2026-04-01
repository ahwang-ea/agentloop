import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok } from '../../shared/result.js';
import { runWriterCleanup, startWrite } from '../writer.js';

const task = {
  id: 'task-1',
  title: 'Implement contacts route',
  description: 'Create the route file.',
  type: 'implement' as const,
  priority: 'medium' as const,
  createdAt: '2026-03-31T00:00:00.000Z',
  scope: { editableFiles: ['src/routes/*.ts'], readOnlyContext: ['AGENTS.md'], forbiddenFiles: [] },
  acceptanceCriteria: ['Create the route file and make verify pass'],
};
const git = { trackedFiles: async () => ok([]), revertFiles: async () => ok(undefined) } as never;

test('retries claude fallback when the first initial write changes no files', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentloop-writer-fallback-'));
  await mkdir(join(cwd, 'src', 'routes'), { recursive: true });
  let starts = 0, waits = 0;
  const result = await startWrite({
    config: { repoPath: '.', useCodexWriter: true }, git,
    codexWriter: { write: async () => ok({ text: 'noop', changedFiles: [], tokenEstimate: 1 }), fix: async () => ok({ text: 'noop', changedFiles: [], tokenEstimate: 1 }) } as never,
    claude: {
      startSession: async () => ok({ id: `claude-${++starts}`, taskId: task.id }),
      waitForStop: async () => ++waits === 1 ? ok({ text: 'noop', changedFiles: [], tokenEstimate: 1 }) : (await writeFile(join(cwd, 'src', 'routes', 'contacts.ts'), 'export const contacts = true;\n', 'utf-8'), ok({ text: 'done', changedFiles: ['src/routes/contacts.ts'], tokenEstimate: 1 })),
    } as never,
  } as never, task, cwd);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(starts).toBe(2);
  expect(await readFile(join(cwd, 'src', 'routes', 'contacts.ts'), 'utf-8')).toContain('contacts');
});

test('treats commented-out or empty source files as placeholder output', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentloop-writer-placeholder-'));
  await mkdir(join(cwd, 'src', 'routes'), { recursive: true });
  let starts = 0;
  const result = await startWrite({
    config: { repoPath: '.', useCodexWriter: true }, git,
    codexWriter: {
      write: async () => (await writeFile(join(cwd, 'src', 'routes', 'deals.ts'), '', 'utf-8'), ok({ text: 'placeholder', changedFiles: ['src/routes/deals.ts'], tokenEstimate: 1 })),
      fix: async () => ok({ text: 'noop', changedFiles: [], tokenEstimate: 1 }),
    } as never,
    claude: {
      startSession: async () => ok({ id: `claude-${++starts}`, taskId: task.id }),
      waitForStop: async () => (await writeFile(join(cwd, 'src', 'routes', 'deals.ts'), 'export const deals = true;\n', 'utf-8'), ok({ text: 'done', changedFiles: ['src/routes/deals.ts'], tokenEstimate: 1 })),
    } as never,
  } as never, task, cwd);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(starts).toBe(1);
  expect(await readFile(join(cwd, 'src', 'routes', 'deals.ts'), 'utf-8')).toContain('deals');
});

test('falls back to claude when codex write returns a session error', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentloop-writer-session-error-'));
  await mkdir(join(cwd, 'src', 'routes'), { recursive: true });
  let prompt = '';
  const result = await startWrite({
    config: { repoPath: '.', useCodexWriter: true }, git,
    codexWriter: { write: async () => err('SESSION_ERROR', 'codex write failed'), fix: async () => err('SESSION_ERROR', 'codex fix failed') } as never,
    claude: {
      startSession: async (_task: unknown, _cwd: string, _warm: unknown, nextPrompt: string) => (prompt = nextPrompt, ok({ id: 'claude-1', taskId: task.id })),
      waitForStop: async () => (await writeFile(join(cwd, 'src', 'routes', 'notes.ts'), 'export const notes = true;\n', 'utf-8'), ok({ text: 'done', changedFiles: ['src/routes/notes.ts'], tokenEstimate: 1 })),
    } as never,
  } as never, task, cwd);
  expect(result.ok).toBe(true);
  expect(prompt).toContain('Previous Codex attempt failed: codex write failed');
});

test('falls back to claude when codex cli is unavailable', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentloop-writer-config-error-'));
  await mkdir(join(cwd, 'src', 'routes'), { recursive: true });
  let prompt = '';
  const result = await startWrite({
    config: { repoPath: '.', useCodexWriter: true }, git,
    codexWriter: { write: async () => err('CONFIG_ERROR', 'Codex CLI is required when useCodexWriter=true'), fix: async () => err('CONFIG_ERROR', 'Codex CLI is required when useCodexWriter=true') } as never,
    claude: {
      startSession: async (_task: unknown, _cwd: string, _warm: unknown, nextPrompt: string) => (prompt = nextPrompt, ok({ id: 'claude-2', taskId: task.id })),
      waitForStop: async () => (await writeFile(join(cwd, 'src', 'routes', 'tasks.ts'), 'export const tasks = true;\n', 'utf-8'), ok({ text: 'done', changedFiles: ['src/routes/tasks.ts'], tokenEstimate: 1 })),
    } as never,
  } as never, task, cwd);
  expect(result.ok).toBe(true);
  expect(prompt).toContain('Previous Codex attempt failed: Codex CLI is required when useCodexWriter=true');
});

test('falls back to claude cleanup when codex cleanup fails', async () => {
  let cleanupCalls = 0;
  const result = await runWriterCleanup({
    config: { repoPath: '.', useCodexWriter: true }, git,
    codexWriter: { write: async () => ok({ text: 'noop', changedFiles: [], tokenEstimate: 1 }), fix: async () => err('SESSION_ERROR', 'codex cleanup failed') } as never,
    claude: { cleanup: async () => (cleanupCalls += 1, ok({ text: 'clean', changedFiles: [], tokenEstimate: 2 })) } as never,
  } as never, { id: 'claude-cleanup', taskId: task.id }, task, '.');
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(cleanupCalls).toBe(1);
  expect(result.value.changedFiles).toEqual([]);
  expect(result.value.tokenEstimate).toBe(2);
});

test('returns claude cleanup failure when fallback also fails', async () => {
  const result = await runWriterCleanup({
    config: { repoPath: '.', useCodexWriter: true }, git,
    codexWriter: { write: async () => ok({ text: 'noop', changedFiles: [], tokenEstimate: 1 }), fix: async () => err('SESSION_ERROR', 'codex cleanup failed') } as never,
    claude: { cleanup: async () => err('TRANSPORT_ERROR', 'claude cleanup failed') } as never,
  } as never, { id: 'claude-cleanup', taskId: task.id }, task, '.');
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'TRANSPORT_ERROR', message: 'claude cleanup failed' }) });
});
