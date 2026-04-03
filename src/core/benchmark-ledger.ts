import { execFile } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BenchmarkResult } from '../benchmarks/types.js';
import { err, ok, type Result } from '../shared/result.js';

const exec = promisify(execFile), header = 'timestamp\tsuite\tscore\ttasks\tstuck\tchecks_passed\tchecks_total\tduration_sec\tfirst_pass_rate\tgit_sha\tgolden_passed\tgolden_total';
const golden = (result: BenchmarkResult) => result.acceptanceTests.filter(test => test.name === 'golden' || test.name.startsWith('golden:'));
const writeErr = (path: string) => err('TRANSPORT_ERROR', `Cannot write benchmark ledger ${path}`);

export async function appendLedgerEntry(repoPath: string, result: BenchmarkResult, suite: string): Promise<Result<void>> {
  const path = join(repoPath, '.agentloop', 'benchmark-ledger.tsv'), checks = result.acceptanceTests, goldenTests = golden(result);
  let gitSha = '';
  try { gitSha = (await exec('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoPath })).stdout.trim(); }
  catch { return err('GIT_ERROR', `Cannot read git sha for ${repoPath}`); }
  const row = [result.timestamp, suite, result.score, `${result.tasksCompleted}/${result.tasksTotal}`, result.tasksStuck, `${checks.filter(test => test.passed).length}/${checks.length}`, checks.length, result.duration, result.firstPassRate, gitSha, goldenTests.filter(test => test.passed).length, goldenTests.length].join('\t') + '\n';
  try { await mkdir(join(repoPath, '.agentloop'), { recursive: true }); await writeFile(path, `${header}\n${row}`, { encoding: 'utf-8', flag: 'wx' }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return writeErr(path); try { await appendFile(path, row, 'utf-8'); } catch { return writeErr(path); } }
  return ok(undefined);
}
