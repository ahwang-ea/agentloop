import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from '../../shared/result.js';
import { applyScaffold, parseScaffoldOutput, scaffoldTask } from '../scaffold.js';

const repo = () => mkdtemp(join(tmpdir(), 'agentloop-scaffold-'));
const task = {
  id: 'task-1',
  title: 'Add parser',
  description: 'Implement a parser.',
  scope: { editableFiles: ['src/**/*'], readOnlyContext: [], forbiddenFiles: [] },
  acceptanceCriteria: ['Parser handles empty input.'],
  priority: 'medium' as const,
  createdAt: new Date().toISOString(),
};

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
