import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCurrentScope, currentScopePath } from '../scope-file.js';

const repos: string[] = [];
const repo = async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentloop-scope-file-'));
  repos.push(cwd);
  await mkdir(join(cwd, 'src'), { recursive: true });
  return cwd;
};
const task = {
  id: 'task-1',
  scope: { editableFiles: ['src/**/*.ts'], readOnlyContext: ['AGENTS.md'], forbiddenFiles: ['src/secret.ts'] },
};
const runHook = (cwd: string, filePath: string) => spawnSync('python3', [join(process.cwd(), 'hooks', 'scope-check.py')], {
  cwd,
  encoding: 'utf8',
  input: JSON.stringify({ tool_input: { file_path: filePath } }),
});

afterEach(async () => {
  await Promise.all(repos.splice(0).map(cwd => rm(cwd, { recursive: true, force: true })));
});

test('writes versioned scope state for the active task', async () => {
  const cwd = await repo();
  const result = await writeCurrentScope(cwd, task, 'fix');
  expect(result.ok).toBe(true);
  const scope = JSON.parse(await readFile(currentScopePath(cwd), 'utf-8')) as Record<string, unknown>;
  expect(scope).toEqual(expect.objectContaining({ version: 1, taskId: 'task-1', phase: 'fix' }));
  expect(scope.editableFiles).toEqual(['src/**/*.ts']);
});

test('hook allows absolute in-scope paths and blocks forbidden files', async () => {
  const cwd = await repo();
  const scoped = await writeCurrentScope(cwd, task, 'write');
  expect(scoped.ok).toBe(true);
  const allowed = runHook(cwd, join(cwd, 'src', 'lib', 'allowed.ts'));
  expect(allowed.status).toBe(0);
  const blocked = runHook(cwd, join(cwd, 'src', 'secret.ts'));
  expect(blocked.status).toBe(2);
  expect(blocked.stdout).toContain('BLOCKED');
});
