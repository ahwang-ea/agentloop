import { jest } from '@jest/globals';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from '../../shared/result.js';
import { applyScaffold, parseScaffoldOutput, preGenerateScaffold, scaffoldTask } from '../scaffold.js';
import { consumeStagedScaffold, scaffoldStageDir } from '../scaffold-stage.js';

const repo = () => mkdtemp(join(tmpdir(), 'agentloop-scaffold-'));
const task = {
  id: 'task-1',
  title: 'Add parser',
  description: 'Implement a parser.',
  type: 'implement' as const,
  scope: { editableFiles: ['src/types.ts'], readOnlyContext: [], forbiddenFiles: [] },
  acceptanceCriteria: ['Parser handles empty input.'],
  priority: 'medium' as const,
  createdAt: new Date().toISOString(),
};

afterEach(() => { jest.restoreAllMocks(); });

test('parses scaffold JSON with content and golden-copy files', () => {
  const parsed = parseScaffoldOutput('```json\n{"files":[{"type":"stub","path":"src/parser.ts","content":"stub"},{"type":"golden-copy","path":"src/parser.test.ts","referencePath":"src/example.test.ts"}]}\n```');
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(parsed.value.files).toHaveLength(2);
});

test('writes scaffold files into the worktree', async () => {
  const repoPath = await repo();
  await mkdir(join(repoPath, 'src'), { recursive: true });
  await writeFile(join(repoPath, 'src', 'example.ts'), 'export const example = 1;\n', 'utf-8');
  const applied = await applyScaffold(repoPath, {
    files: [
      { type: 'stub', path: 'src/parser.ts', content: "export const parse = () => 'x';\n" },
      { type: 'golden-copy', path: 'src/parser.test.ts', referencePath: 'src/example.ts' },
    ],
  });
  expect(applied.ok).toBe(true);
  if (applied.ok) expect(applied.value).toEqual(['src/parser.ts', 'src/parser.test.ts']);
  expect(await readFile(join(repoPath, 'src', 'parser.ts'), 'utf-8')).toContain('parse');
  expect(await readFile(join(repoPath, 'src', 'parser.test.ts'), 'utf-8')).toContain('example');
});

test('rejects scaffold paths that escape the worktree', async () => {
  const repoPath = await repo();
  const applied = await applyScaffold(repoPath, { files: [{ type: 'test', path: '../escape.ts', content: 'nope' }] });
  expect(applied.ok).toBe(false);
  if (!applied.ok) expect(applied.error.code).toBe('SESSION_ERROR');
});

test('asks Claude for scaffold output and writes it', async () => {
  const repoPath = await repo();
  const applied = await scaffoldTask({
    scaffold: async () => ok({ files: [{ type: 'types', path: 'src/types.ts', content: 'export type Id = string;\n' }] }),
  }, task, repoPath);
  expect(applied.ok).toBe(true);
  expect(await readFile(join(repoPath, 'src', 'types.ts'), 'utf-8')).toContain('Id');
});

test('pre-generates scaffold files into staging and later consumes them', async () => {
  const repoPath = await repo(), stage = scaffoldStageDir(repoPath, task.id), worktree = join(repoPath, '.worktrees', 'task');
  const stagedTask = { ...task, scope: { ...task.scope, editableFiles: ['src/*.ts'] } };
  await mkdir(join(repoPath, 'src'), { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(join(repoPath, 'src', 'example.ts'), 'export const example = 1;\n', 'utf-8');
  const staged = await preGenerateScaffold({
    scaffold: async () => ok({ files: [
      { type: 'types', path: 'src/types.ts', content: 'export type Id = string;\n' },
      { type: 'golden-copy', path: 'src/example.test.ts', referencePath: 'src/example.ts' },
    ] }),
  }, stagedTask, stage);
  expect(staged.ok).toBe(true);
  expect(await readFile(join(stage, 'src', 'types.ts'), 'utf-8')).toContain('Id');
  expect(await readFile(join(stage, 'src', 'example.test.ts'), 'utf-8')).toContain('example');
  const consumed = await consumeStagedScaffold(repoPath, task.id, worktree);
  expect(consumed.ok).toBe(true);
  if (!consumed.ok) return;
  expect(consumed.value).toEqual(['src/example.test.ts', 'src/types.ts']);
  expect(await readFile(join(worktree, 'src', 'example.test.ts'), 'utf-8')).toContain('example');
  expect(await readFile(join(worktree, 'src', 'types.ts'), 'utf-8')).toContain('Id');
  await expect(stat(stage)).rejects.toThrow();
});

test('replaces staged scaffold output without consuming stale or temp files', async () => {
  const repoPath = await repo(), stage = scaffoldStageDir(repoPath, task.id), worktree = join(repoPath, '.worktrees', 'task');
  const stagedTask = { ...task, scope: { ...task.scope, editableFiles: ['src/*.ts'] } };
  await mkdir(worktree, { recursive: true });
  expect((await preGenerateScaffold({
    scaffold: async () => ok({ files: [{ type: 'types', path: 'src/old.ts', content: 'export const oldValue = 1;\n' }] }),
  }, stagedTask, stage)).ok).toBe(true);
  expect((await preGenerateScaffold({
    scaffold: async () => ok({ files: [{ type: 'types', path: 'src/new.ts', content: 'export const newValue = 1;\n' }] }),
  }, stagedTask, stage)).ok).toBe(true);
  await mkdir(join(`${stage}.pending.tmp`, 'src'), { recursive: true });
  await writeFile(join(`${stage}.pending.tmp`, 'src', 'partial.ts'), 'export const partial = 1;\n', 'utf-8');
  await expect(stat(join(stage, 'src', 'old.ts'))).rejects.toThrow();
  const consumed = await consumeStagedScaffold(repoPath, task.id, worktree);
  expect(consumed.ok).toBe(true);
  if (!consumed.ok) return;
  expect(consumed.value).toEqual(['src/new.ts']);
  expect(await readFile(join(worktree, 'src', 'new.ts'), 'utf-8')).toContain('newValue');
  await expect(stat(join(worktree, 'src', 'old.ts'))).rejects.toThrow();
  await expect(stat(join(worktree, 'src', 'partial.ts'))).rejects.toThrow();
});


test('skips out-of-scope scaffold files', async () => {
  jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  const repoPath = await repo();
  const applied = await scaffoldTask({
    scaffold: async () => ok({ files: [
      { type: 'types', path: 'src/types.ts', content: "export type Id = string;\n" },
      { type: 'test', path: 'src/__tests__/types.test.ts', content: "test('x', () => {});\n" },
    ] }),
  }, task, repoPath);
  expect(applied.ok).toBe(true);
  if (!applied.ok) return;
  expect(applied.value).toEqual(['src/types.ts']);
});
