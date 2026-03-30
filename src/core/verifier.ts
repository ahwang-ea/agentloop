// core/verifier.ts — Runs verify command, parses output into structured errors.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { ok, err, type Result } from '../shared/result.js';
import type { VerifyResult } from '../types/index.js';

const exec = promisify(execFile);

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
    if (typeof error.code === 'string' && error.code === 'ENOENT') {
      return err('VERIFY_FAILED', `Verify command not found: ${command}`);
    }
    const output = (error.stdout ?? '') + (error.stderr ?? '');
    let errors = parseVerifyOutput(output);
    if (errors.length === 0) {
      const fallback = output.trim() || `verify-exit-${error.code ?? 'unknown'}`;
      errors = [{ source: 'build', message: fallback.slice(0, 500), hash: createHash('sha256').update(fallback).digest('hex').slice(0, 12) }];
    }
    return ok({ pass: false, output, errors, duration });
  }
}

function parseVerifyOutput(output: string) {
  const errors: { source: 'typecheck' | 'test' | 'lint' | 'build' | 'doc-freshness'; message: string; file?: string; line?: number; hash: string }[] = [];
  const lines = output.split('\n');
  for (const line of lines) {
    const match = line.match(/^(.+?):(\d+):\d+:\s*(error|warning):\s*(.+)/);
    if (!match) continue;
    const message = match[4];
    errors.push({
      source: 'typecheck',
      message,
      file: match[1],
      line: parseInt(match[2], 10),
      hash: createHash('sha256').update(`${match[1]}:${message}`).digest('hex').slice(0, 12),
    });
  }
  return errors;
}
