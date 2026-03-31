// core/verifier.ts — Runs verify command, parses output into structured errors.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { ok, err, type Result } from '../shared/result.js';
import type { AgentloopConfig, TaskType, VerifyResult } from '../types/index.js';

const exec = promisify(execFile);
const quote = (value: string) => `'${value.replace(/'/g, `"'"'`)}'`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);

export function truncateVerifyOutput(output: string): string {
  const lines = output.split('\n');
  if (lines.length <= 100) return output;
  return [...lines.slice(0, 50), '... (truncated) ...', ...lines.slice(-10)].join('\n');
}

export async function runVerify(command: string, cwd = process.cwd(), env = process.env): Promise<Result<VerifyResult>> {
  const start = Date.now();
  try {
    const { stdout, stderr } = await exec('bash', ['-c', command], { cwd, env, timeout: 120_000 });
    return ok({ pass: true, output: stdout + stderr, errors: [], duration: (Date.now() - start) / 1000 });
  } catch (e: unknown) {
    const duration = (Date.now() - start) / 1000;
    const error = e as { stdout?: string; stderr?: string; code?: number | string };
    if (typeof error.code === 'string' && error.code === 'ENOENT') return err('VERIFY_FAILED', `Verify command not found: ${command}`);
    const output = (error.stdout ?? '') + (error.stderr ?? '');
    let errors = parseVerifyOutput(output);
    if (errors.length === 0) {
      const fallback = output.trim() || `verify-exit-${error.code ?? 'unknown'}`;
      errors = [{ source: 'build', message: fallback.slice(0, 500), hash: hash(fallback) }];
    }
    return ok({ pass: false, output, errors, duration });
  }
}

async function integrationVerify(config: AgentloopConfig, cwd: string): Promise<Result<VerifyResult>> {
  return config.integrationTestCommand ? runVerify(config.integrationTestCommand, cwd) : err('CONFIG_ERROR', 'integrationTestCommand is required for integrate tasks');
}

export async function progressiveVerify(
  config: AgentloopConfig, changedFiles: string[], cwd: string, mergeMode: boolean, taskType: TaskType = 'implement',
): Promise<Result<VerifyResult>> {
  const args = ['--progressive', ...(mergeMode ? ['--merge'] : []), ...changedFiles.map(quote)].join(' ');
  const verify = await runVerify(`${config.verifyCommand} ${args}`.trim(), cwd, mergeMode ? { ...process.env, AGENTLOOP_MERGE_CHECK: '1' } : process.env);
  if (!verify.ok || !verify.value.pass || taskType !== 'integrate') return verify;
  return integrationVerify(config, cwd);
}

function parseVerifyOutput(output: string) {
  const errors: { source: 'typecheck' | 'test' | 'lint' | 'build' | 'doc-freshness'; message: string; file?: string; line?: number; hash: string }[] = [];
  const lines = output.split('\n');
  let failingTest: string | undefined, testName: string | undefined, expected: string | undefined, received: string | undefined, testLine: number | undefined, diff: string[] = [];
  const pushTest = () => {
    if (!failingTest || !testName) return;
    const detail = expected || received ? `Expected: ${expected ?? '?'}; Received: ${received ?? '?'}` : diff.length > 0 ? `Diff: ${diff.slice(0, 6).join(' ')}` : '';
    const message = [testName, detail].filter(Boolean).join(' — ');
    errors.push({ source: 'test', file: failingTest, line: testLine, message, hash: hash(`${failingTest}:${testLine ?? 0}:${message}`) });
    testName = undefined; expected = undefined; received = undefined; testLine = undefined; diff = [];
  };
  for (const line of lines) {
    const match = line.match(/^(.+?):(\d+):\d+:\s*(error|warning):\s*(.+)/);
    if (match) {
      pushTest();
      const message = match[4];
      errors.push({ source: 'typecheck', message, file: match[1], line: parseInt(match[2], 10), hash: hash(`${match[1]}:${message}`) });
      continue;
    }
    const failed = line.match(/^FAIL\s+(.+)/);
    if (failed) { pushTest(); failingTest = failed[1].trim(); continue; }
    if (failingTest && line.includes('Your test suite must contain at least one test.')) {
      pushTest();
      const message = 'Your test suite must contain at least one test.';
      errors.push({ source: 'test', file: failingTest, message, hash: hash(`${failingTest}:${message}`) });
      failingTest = undefined;
      continue;
    }
    const failedCase = failingTest ? line.match(/^\s*●\s+(.+)/) : null;
    if (failingTest && failedCase) {
      pushTest();
      if (failedCase[1] === 'Test suite failed to run') continue;
      testName = failedCase[1].trim();
      diff = [];
      continue;
    }
    if (!testName) continue;
    const nextExpected = line.match(/^\s*Expected:\s+(.+)/); if (nextExpected) expected = nextExpected[1].trim();
    const nextReceived = line.match(/^\s*Received:\s+(.+)/); if (nextReceived) received = nextReceived[1].trim();
    const trimmed = line.trim();
    if (diff.length < 6 && (/^[+-]\s{3,}/.test(trimmed) || trimmed === 'Object {')) diff.push(trimmed);
    const location = line.match(/^\s*at Object\.<anonymous> \(([^:]+):(\d+):(\d+)\)/);
    if (location && (!failingTest || location[1] === failingTest)) testLine = parseInt(location[2], 10);
  }
  pushTest();
  return errors;
}
