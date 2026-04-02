import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { err, ok, type Result } from '../shared/result.js';
import { writeStderr } from '../shared/stderr.js';
import type { BenchmarkCatalogEntry } from '../benchmarks/types.js';
import { scaffoldRepo } from './init.js';
import { runBenchmarkRepoSmokeTest } from './preflight.js';

const exec = promisify(execFile), npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const fixedDevDeps = ['typescript', 'jest', 'ts-jest', '@types/node', '@types/jest'];
const depParts = (dep: string) => {
  const split = dep.startsWith('@') ? dep.lastIndexOf('@') : dep.indexOf('@');
  return split > 0 ? [dep.slice(0, split), dep.slice(split + 1)] : [dep, 'latest'];
};
const depMap = (deps: string[]) => Object.fromEntries(deps.slice().sort().map(dep => depParts(dep)));
const npmCacheDir = (deps: string[]) => join(tmpdir(), 'agentloop-npm-cache', createHash('sha256').update(deps.slice().sort().join('\n')).digest('hex'));
const copyNodeModules = async (from: string, to: string, label: string, optional = false): Promise<boolean> => {
  try { await stat(from); }
  catch (e) {
    if (optional && e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return false;
    writeStderr(`[benchmark:${label}] npm cache source missing: ${e instanceof Error ? e.message : 'unknown error'}`);
    return false;
  }
  try { await cp(from, to, { recursive: true }); return true; }
  catch (e) { writeStderr(`[benchmark:${label}] npm cache copy failed: ${e instanceof Error ? e.message : 'unknown error'}`); return false; }
};
const pkg = (name: string, runtimeDeps: string[], devDeps: string[]) => JSON.stringify({
  name: `benchmark-${name}`, version: '0.0.0', type: 'module',
  scripts: { typecheck: 'tsc --noEmit', test: 'node --experimental-vm-modules ./node_modules/jest/bin/jest.js --maxWorkers=100%', build: 'tsc' },
  dependencies: depMap(runtimeDeps),
  devDependencies: depMap(devDeps),
}, null, 2);
const jest = [
  'module.exports = {', "  preset: 'ts-jest/presets/default-esm',", "  testEnvironment: 'node',", "  extensionsToTreatAsEsm: ['.ts'],", "  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },", "  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: true }] },", "  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/dist/', '<rootDir>/.worktrees/'],", "  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/.worktrees/'],", '};',
].join('\n');
const tsconfig = JSON.stringify({
  compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
    strict: true, esModuleInterop: true, rootDir: 'src', outDir: 'dist',
    skipLibCheck: true, declaration: true, resolveJsonModule: true,
    isolatedModules: true,
    types: ['node', 'jest'],
  },
  include: ['src/**/*.ts'], exclude: ['node_modules', 'dist'],
}, null, 2);
const gitignore = ['node_modules', 'dist/', '.agentloop/', '.worktrees/', '*.tsbuildinfo'].join('\n');
const smoke = ['', "describe('smoke', () => {", "  test('benchmark repo boots', () => {", '    expect(true).toBe(true);', '  });', '});'].join('\n');
const run = async (cmd: string, args: string[], cwd: string, timeout = 900_000): Promise<Result<void>> => {
  try { await exec(cmd, args, { cwd, timeout, maxBuffer: 20_000_000 }); return ok(undefined); }
  catch (e) { return err('TRANSPORT_ERROR', `${cmd} ${args.join(' ')} failed: ${e instanceof Error ? e.message : 'unknown error'}`); }
};
const appendArchitecture = async (repoPath: string, notes?: string): Promise<Result<void>> => {
  if (!notes?.trim()) return ok(undefined);
  try {
    await appendFile(join(repoPath, 'ARCHITECTURE.md'), `\n\n## Benchmark Notes\n${notes.trim()}\n`, 'utf-8');
    return ok(undefined);
  } catch (e) {
    return err('TRANSPORT_ERROR', `Cannot update benchmark architecture: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
};

export async function bootstrapBenchmarkRepo(entry: BenchmarkCatalogEntry): Promise<Result<string>> {
  const repoPath = await mkdtemp(join(tmpdir(), `agentloop-${entry.id}-`));
  let keep = false;
  try {
    const baseDeps = entry.suite.baseDeps ?? [];
    const runtimeDeps = baseDeps.filter(dep => !dep.startsWith('@types/'));
    const devDeps = [...baseDeps.filter(dep => dep.startsWith('@types/')), ...fixedDevDeps];
    const cacheDir = npmCacheDir(baseDeps);
    await Promise.all([
      writeFile(join(repoPath, 'package.json'), `${pkg(entry.id, runtimeDeps, devDeps)}\n`, 'utf-8'),
      writeFile(join(repoPath, 'tsconfig.json'), `${tsconfig}\n`, 'utf-8'),
      writeFile(join(repoPath, 'jest.config.cjs'), `${jest}\n`, 'utf-8'),
      writeFile(join(repoPath, '.gitignore'), `${gitignore}\n`, 'utf-8'),
    ]);
    await mkdir(join(repoPath, 'src', '__tests__'), { recursive: true });
    await writeFile(join(repoPath, 'src', '__tests__', 'smoke.test.ts'), `${smoke}\n`, 'utf-8');
    const restored = await copyNodeModules(join(cacheDir, 'node_modules'), join(repoPath, 'node_modules'), entry.fileStem, true);
    if (!restored) {
      const installed = await run(npm, ['install'], repoPath); if (!installed.ok) return installed;
      await mkdir(cacheDir, { recursive: true });
      const cached = await copyNodeModules(join(repoPath, 'node_modules'), join(cacheDir, 'node_modules'), entry.fileStem);
      if (cached) writeStderr(`[benchmark:${entry.fileStem}] saved npm cache ${cacheDir}`);
    } else writeStderr(`[benchmark:${entry.fileStem}] restored npm cache ${cacheDir}`);
    const scaffolded = await scaffoldRepo(repoPath, { smartInit: false }); if (!scaffolded.ok) return scaffolded;
    const smokeReady = await runBenchmarkRepoSmokeTest(repoPath); if (!smokeReady.ok) return smokeReady;
    const architecture = await appendArchitecture(repoPath, entry.suite.architectureNotes); if (!architecture.ok) return architecture;
    for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'benchmark@agentloop.local'], ['config', 'user.name', 'agentloop benchmark'], ['add', '.'], ['commit', '-m', 'bootstrap benchmark']]) {
      const git = await run('git', args, repoPath); if (!git.ok) return git;
    }
    keep = true;
    return ok(repoPath);
  } catch { return err('TRANSPORT_ERROR', `Cannot bootstrap benchmark repo ${repoPath}`); }
  finally { if (!keep) await rm(repoPath, { recursive: true, force: true }); }
}
