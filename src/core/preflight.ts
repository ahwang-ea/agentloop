import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig } from '../types/index.js';
import { verifyCodexCli } from './codex-writer.js';

const exec = promisify(execFile);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
type Run = (cmd: string, args: string[], cwd?: string) => Promise<Result<string>>;
export interface PreflightDeps {
  env: NodeJS.ProcessEnv;
  exists(path: string): Promise<boolean>;
  run: Run;
  verifyCodexCli(): Promise<Result<void>>;
}
const shell: PreflightDeps = {
  env: process.env,
  exists: path => access(path, constants.F_OK).then(() => true).catch(() => false),
  run: async (cmd, args, cwd) => {
    try {
      const { stdout, stderr } = await exec(cmd, args, { cwd });
      return ok(`${stdout}${stderr}`.trim());
    } catch (e) {
      return err('TRANSPORT_ERROR', `${cmd} ${args.join(' ')} failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  },
  verifyCodexCli,
};
const abs = (root: string, path: string) => isAbsolute(path) ? path : join(root, path);
const strip = (value: string) => value.replace(/^['"]|['"]$/g, '');
const verifyFile = (config: AgentloopConfig) => {
  const token = config.verifyCommand.split(/\s+/).map(strip).find(part => /(?:^|\/)verify\.sh$/.test(part));
  return token ? abs(config.repoPath, token.replace(/^\.\//, '')) : undefined;
};
const taskPath = (config: AgentloopConfig) => relative(config.repoPath, abs(config.repoPath, config.taskFilePath ?? 'tasks.json')).replace(/^\.\//, '');
const ignorable = (config: AgentloopConfig, path: string) => path === taskPath(config)
  || path.startsWith('.agentloop/')
  || path.startsWith('.context/')
  || path.startsWith('.worktrees/');

export async function runStartPreflight(config: AgentloopConfig, deps: PreflightDeps = shell): Promise<Result<void>> {
  if (!deps.env.ANTHROPIC_API_KEY) return err('CONFIG_ERROR', 'ANTHROPIC_API_KEY is required for start');
  if (config.codexEnabled && !deps.env.OPENAI_API_KEY) return err('CONFIG_ERROR', 'OPENAI_API_KEY is required when codexEnabled=true');
  const verifyPath = verifyFile(config);
  if (verifyPath && !(await deps.exists(verifyPath))) return err('CONFIG_ERROR', `verify command references missing file ${verifyPath}`);
  const agents = abs(config.repoPath, config.agentsMdPath);
  if (!(await deps.exists(agents))) return err('CONFIG_ERROR', `Missing AGENTS.md at ${agents}`);
  if (config.architectureMdPath) {
    const architecture = abs(config.repoPath, config.architectureMdPath);
    if (!(await deps.exists(architecture))) return err('CONFIG_ERROR', `Missing ARCHITECTURE.md at ${architecture}`);
  }
  const repo = await deps.run('git', ['rev-parse', '--is-inside-work-tree'], config.repoPath);
  if (!repo.ok) return repo;
  if (repo.value !== 'true') return err('CONFIG_ERROR', `Repo is not a git worktree: ${config.repoPath}`);
  const branch = await deps.run('git', ['rev-parse', '--verify', config.baseBranch], config.repoPath);
  if (!branch.ok) return err('CONFIG_ERROR', `Base branch ${config.baseBranch} does not exist`);
  const status = await deps.run('git', ['status', '--porcelain'], config.repoPath);
  if (!status.ok) return status;
  const dirty = status.value.split('\n').map(line => line.slice(3).trim()).filter(Boolean).filter(path => !ignorable(config, path));
  if (dirty.length > 0) return err('DIRTY_TREE', `Start preflight requires a clean repo: ${dirty.slice(0, 5).join(', ')}`);
  if (!config.useCodexWriter) return ok(undefined);
  const codex = await deps.verifyCodexCli();
  return !codex.ok && codex.error.code !== 'CONFIG_ERROR' ? codex : ok(undefined);
}

export async function runBenchmarkPreflight(config: AgentloopConfig, deps: PreflightDeps = shell): Promise<Result<void>> {
  if (!deps.env.ANTHROPIC_API_KEY || !deps.env.OPENAI_API_KEY) return err('CONFIG_ERROR', 'benchmark requires ANTHROPIC_API_KEY and OPENAI_API_KEY');
  const npmReady = await deps.run(npm, ['--version']);
  if (!npmReady.ok) return err('CONFIG_ERROR', `Benchmark preflight requires npm: ${npmReady.error.message}`);
  const gitReady = await deps.run('git', ['--version']);
  if (!gitReady.ok) return err('CONFIG_ERROR', `Benchmark preflight requires git: ${gitReady.error.message}`);
  if (!config.useCodexWriter) return ok(undefined);
  const codex = await deps.verifyCodexCli();
  return !codex.ok && codex.error.code !== 'CONFIG_ERROR' ? codex : ok(undefined);
}

export async function runBenchmarkRepoSmokeTest(repoPath: string, run: Run = shell.run): Promise<Result<void>> {
  const smoke = await run(npm, ['test', '--', '--runTestsByPath', 'src/__tests__/smoke.test.ts', '--maxWorkers=100%'], repoPath);
  return smoke.ok ? ok(undefined) : err(smoke.error.code, `Benchmark smoke test failed: ${smoke.error.message}`);
}
