import type { AgentloopConfig } from '../../types/index.js';
import { err, ok } from '../../shared/result.js';
import { runBenchmarkPreflight, runBenchmarkRepoSmokeTest, runStartPreflight } from '../preflight.js';

const config = (repoPath = '/repo'): AgentloopConfig => ({
  repoPath,
  baseBranch: 'main',
  branchPrefix: 'al/',
  worktreeRoot: '.worktrees',
  verifyCommand: './verify.sh',
  agentsMdPath: 'AGENTS.md',
  architectureMdPath: 'ARCHITECTURE.md',
  claudeModel: 'claude',
  codexModel: 'codex',
  codexEnabled: true,
  useCodexWriter: true,
  autoApproveResearch: false,
  convergence: { maxWallClock: 1, maxTokens: 1, stuckThreshold: 1, thrashOverlapRatio: 0.5 },
  taskSource: 'file',
  taskFilePath: 'tasks.json',
  maxParallelAgents: 2,
  maxTasksPerSession: 3,
  maxTokensPerSession: 100000,
  parallelVerify: true,
  sweepInterval: 1,
});
const deps = (overrides: Partial<Parameters<typeof runStartPreflight>[1]> = {}) => ({
  env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' },
  exists: async () => true,
  run: async (cmd: string, args: string[]) => ok(cmd === 'git' && args[0] === 'status' ? '' : cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree' ? 'true' : 'ok'),
  verifyCodexCli: async () => ok(undefined),
  ...overrides,
});

test('start preflight rejects missing verify script', async () => {
  const result = await runStartPreflight(config(), deps({ exists: async path => !path.endsWith('verify.sh') }));
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'CONFIG_ERROR' }) });
});

test('start preflight ignores generated files but blocks real dirty files', async () => {
  const clean = await runStartPreflight(config(), deps({ run: async (cmd, args) => ok(cmd === 'git' && args[0] === 'status' ? '?? .agentloop/metrics.jsonl\n?? tasks.json' : cmd === 'git' && args[1] === '--is-inside-work-tree' ? 'true' : 'ok') }));
  expect(clean.ok).toBe(true);
  const dirty = await runStartPreflight(config(), deps({ run: async (cmd, args) => ok(cmd === 'git' && args[0] === 'status' ? ' M src/core/writer.ts' : cmd === 'git' && args[1] === '--is-inside-work-tree' ? 'true' : 'ok') }));
  expect(dirty).toEqual({ ok: false, error: expect.objectContaining({ code: 'DIRTY_TREE' }) });
});

test('start preflight rejects missing codex cli when codex writer is enabled', async () => {
  const result = await runStartPreflight(config(), deps({ verifyCodexCli: async () => err('CONFIG_ERROR', 'Codex CLI is required') }));
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'CONFIG_ERROR' }) });
});

test('benchmark preflight requires toolchain and api keys', async () => {
  const missingKeys = await runBenchmarkPreflight(config(), deps({ env: { ANTHROPIC_API_KEY: 'a' } }));
  expect(missingKeys).toEqual({ ok: false, error: expect.objectContaining({ code: 'CONFIG_ERROR' }) });
  const missingNpm = await runBenchmarkPreflight(config(), deps({ run: async (cmd: string) => cmd === (process.platform === 'win32' ? 'npm.cmd' : 'npm') ? err('TRANSPORT_ERROR', 'missing') : ok('ok') }));
  expect(missingNpm).toEqual({ ok: false, error: expect.objectContaining({ code: 'CONFIG_ERROR' }) });
});

test('benchmark smoke test runs the repo smoke suite', async () => {
  let called: string[] = [];
  const result = await runBenchmarkRepoSmokeTest('/repo', async (cmd, args) => (called = [cmd, ...args], ok('')));
  expect(result.ok).toBe(true);
  expect(called).toEqual([process.platform === 'win32' ? 'npm.cmd' : 'npm', 'test', '--', '--runTestsByPath', 'src/__tests__/smoke.test.ts', '--maxWorkers=100%']);
});
