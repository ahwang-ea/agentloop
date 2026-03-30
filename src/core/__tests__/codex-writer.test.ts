import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';

const execFile = jest.fn();
(execFile as typeof execFile & { [key: symbol]: unknown })[Symbol.for('nodejs.util.promisify.custom')] = async (
  file: string, args: string[], options?: { cwd?: string },
) => {
  if (file === 'codex' && args[0] === '--version') return { stdout: 'codex 0.0.0\n', stderr: '' };
  if (file === 'codex' && args[0] === 'exec') {
    const cwd = options?.cwd ?? '', out = args[args.indexOf('-o') + 1];
    await writeFile(out, 'writer output\n', 'utf-8');
    await appendFile(join(cwd, 'tracked.txt'), 'changed\n', 'utf-8');
    await writeFile(join(cwd, 'new.txt'), 'new\n', 'utf-8');
    return { stdout: '', stderr: '' };
  }
  if (file === 'git' && args.join(' ') === 'diff --name-only --relative') return { stdout: 'tracked.txt\n', stderr: '' };
  if (file === 'git' && args.join(' ') === 'ls-files --others --exclude-standard') return { stdout: 'new.txt\n', stderr: '' };
  throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
};

await jest.unstable_mockModule('node:child_process', () => ({ execFile }));
const { createCodexWriterAdapter, verifyCodexCli } = await import('../codex-writer.js');

const repo = () => mkdtemp(join(tmpdir(), 'agentloop-codex-writer-'));

test('verifies codex cli and collects changed files from git state', async () => {
  const repoPath = await repo();
  await writeFile(join(repoPath, 'tracked.txt'), 'base\n', 'utf-8');
  const verified = await verifyCodexCli();
  expect(verified.ok).toBe(true);
  const result = await createCodexWriterAdapter('gpt-4.1').write('implement it', repoPath);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.text).toBe('writer output');
  expect(result.value.tokenEstimate).toBe(0);
  expect(result.value.changedFiles).toEqual(['new.txt', 'tracked.txt']);
  expect(await readFile(join(repoPath, 'tracked.txt'), 'utf-8')).toContain('changed');
});
