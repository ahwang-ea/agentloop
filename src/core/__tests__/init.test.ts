import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldRepo } from '../init.js';

const repo = () => mkdtemp(join(tmpdir(), 'agentloop-init-'));
const exists = (path: string) => access(path, constants.F_OK).then(() => true).catch(() => false);

test('scaffolds npm security files for npm repos', async () => {
  const repoPath = await repo();
  await writeFile(join(repoPath, 'package.json'), '{"name":"demo","version":"1.0.0"}\n', 'utf-8');
  await writeFile(join(repoPath, 'package-lock.json'), '{"name":"demo","lockfileVersion":3}\n', 'utf-8');
  const result = await scaffoldRepo(repoPath);
  expect(result.ok).toBe(true);
  expect(await readFile(join(repoPath, '.npmrc'), 'utf-8')).toContain('min-release-age=7');
  expect(await readFile(join(repoPath, 'socket.yml'), 'utf-8')).toContain('triggerPaths');
  expect(await readFile(join(repoPath, '.github', 'workflows', 'socket-security.yml'), 'utf-8')).toContain('sfw npm ci');
});

test('skips npm security files for non-npm package managers', async () => {
  const repoPath = await repo();
  await writeFile(join(repoPath, 'package.json'), '{"name":"demo","version":"1.0.0"}\n', 'utf-8');
  await writeFile(join(repoPath, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf-8');
  const result = await scaffoldRepo(repoPath);
  expect(result.ok).toBe(true);
  expect(await exists(join(repoPath, '.npmrc'))).toBe(false);
  expect(await exists(join(repoPath, 'socket.yml'))).toBe(false);
  expect(await exists(join(repoPath, '.github', 'workflows', 'socket-security.yml'))).toBe(false);
});
