import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import { ok } from '../../shared/result.js';
import type { BenchmarkCatalogEntry } from '../../benchmarks/types.js';

const execFile = jest.fn((cmd: string, _args: string[], options: { cwd?: string } | undefined, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
  if (cmd === (process.platform === 'win32' ? 'npm.cmd' : 'npm') && options?.cwd) {
    mkdir(join(options.cwd, 'node_modules'), { recursive: true })
      .then(() => writeFile(join(options.cwd!, 'node_modules', 'installed.txt'), 'ok\n', 'utf-8'))
      .then(() => callback(null, '', ''));
    return undefined as never;
  }
  callback(null, '', '');
  return undefined as never;
});
const scaffoldRepo = jest.fn(async () => ok(undefined));
const runBenchmarkRepoSmokeTest = jest.fn(async () => ok(undefined));

await jest.unstable_mockModule('node:child_process', () => ({ execFile }));
await jest.unstable_mockModule('../init.js', () => ({ scaffoldRepo }));
await jest.unstable_mockModule('../preflight.js', () => ({ runBenchmarkRepoSmokeTest }));
const { bootstrapBenchmarkRepo } = await import('../benchmark-bootstrap.js');

const entry: BenchmarkCatalogEntry = {
  id: 'crm',
  fileStem: 'crm',
  suite: { name: 'CRM', goal: 'build a crm', maxTimeSec: 60, baseDeps: ['express', '@types/express'], acceptanceTests: [] },
};
const cacheDir = join(tmpdir(), 'agentloop-npm-cache', createHash('sha256').update(['@types/express', 'express'].join('\n')).digest('hex'));

beforeEach(async () => {
  execFile.mockClear();
  scaffoldRepo.mockClear();
  runBenchmarkRepoSmokeTest.mockClear();
  await rm(cacheDir, { recursive: true, force: true });
});

afterEach(async () => {
  const paths = execFile.mock.calls.map(([, , options]) => options?.cwd).filter((value): value is string => Boolean(value));
  await Promise.all(paths.map(path => rm(path, { recursive: true, force: true })));
  await rm(cacheDir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

test('restores cached node_modules without running npm install', async () => {
  await mkdir(join(cacheDir, 'node_modules'), { recursive: true });
  await writeFile(join(cacheDir, 'node_modules', 'cached.txt'), 'cached\n', 'utf-8');
  const result = await bootstrapBenchmarkRepo(entry);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  await expect(readFile(join(result.value, 'node_modules', 'cached.txt'), 'utf-8')).resolves.toBe('cached\n');
  const packageJson = await readFile(join(result.value, 'package.json'), 'utf-8');
  expect(packageJson).toContain('"express": "latest"');
  expect(packageJson).toContain('"typescript": "latest"');
  expect(execFile.mock.calls.filter(([cmd]) => cmd === (process.platform === 'win32' ? 'npm.cmd' : 'npm'))).toHaveLength(0);
});

test('installs once on cache miss and saves node_modules for reuse', async () => {
  const result = await bootstrapBenchmarkRepo(entry);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  await expect(readFile(join(cacheDir, 'node_modules', 'installed.txt'), 'utf-8')).resolves.toBe('ok\n');
  expect(execFile.mock.calls.filter(([cmd]) => cmd === (process.platform === 'win32' ? 'npm.cmd' : 'npm'))).toHaveLength(1);
});
