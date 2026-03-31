import { jest } from '@jest/globals';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err } from '../../shared/result.js';

const runSmartInit = jest.fn(async () => err('SESSION_ERROR', 'smart init failed'));
const shouldRunSmartInit = jest.fn(() => true);

await jest.unstable_mockModule('../smart-init.js', () => ({ runSmartInit, shouldRunSmartInit }));
const { scaffoldRepo } = await import('../init.js');

const repo = async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-init-smart-'));
  await writeFile(join(repoPath, 'package.json'), '{"name":"demo","version":"1.0.0"}\n', 'utf-8');
  await writeFile(join(repoPath, 'package-lock.json'), '{"name":"demo","lockfileVersion":3}\n', 'utf-8');
  await writeFile(join(repoPath, 'src.ts'), 'export const x = 1;\n', 'utf-8');
  return repoPath;
};

test('can skip smart init during scaffold', async () => {
  const repoPath = await repo();
  const result = await scaffoldRepo(repoPath, { smartInit: false });
  expect(result.ok).toBe(true);
  expect(runSmartInit).not.toHaveBeenCalled();
  expect(await readFile(join(repoPath, 'AGENTS.md'), 'utf-8')).toContain('## What this project does');
});

test('still runs smart init by default', async () => {
  const repoPath = await repo();
  const result = await scaffoldRepo(repoPath);
  expect(result.ok).toBe(false);
  expect(runSmartInit).toHaveBeenCalled();
});
