import { execFile } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { err, ok, type Result } from '../shared/result.js';
import type { AcceptanceTest, BenchmarkResult } from '../benchmarks/types.js';

const exec = promisify(execFile), ignore = new Set(['node_modules', 'dist', '.git']);
const exists = (path: string) => access(path, constants.F_OK).then(() => true).catch(() => false);
const command = (cmd: string) => process.platform === 'win32' && cmd === 'npm' ? 'npm.cmd' : cmd;
const skipped = (path: string) => path.split(/[\\/]/).some(part => ignore.has(part));
const walk = async (root: string, dir: string) => {
  try { return (await readdir(join(root, dir), { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => join(entry.parentPath ?? join(root, dir), entry.name)).filter(path => !skipped(path)); }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : Promise.reject(e); }
};
const files = async (root: string, dir: string, extensions: string[]) => (await walk(root, dir)).filter(path => extensions.some(ext => path.endsWith(ext)));
const text = (value: string) => value.trim() || undefined;

async function run(root: string, test: AcceptanceTest): Promise<BenchmarkResult['acceptanceTests'][number]> {
  if (test.type === 'command') {
    try {
      const { stdout, stderr } = await exec(command(test.cmd), test.args, { cwd: root, timeout: test.timeoutMs ?? 180_000, maxBuffer: 10_000_000 });
      return { name: test.name, passed: (test.expectExitCode ?? 0) === 0, output: text(`${stdout}${stderr}`) };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
      return { name: test.name, passed: (err.code ?? 1) === (test.expectExitCode ?? 0), output: text([err.stderr, err.stdout, err.message].filter(Boolean).join('\n')) };
    }
  }
  if (test.type === 'file-exists') return { name: test.name, passed: (await Promise.all(test.paths.map(path => exists(join(root, path))))).some(Boolean), output: test.paths.join(', ') };
  if (test.type === 'min-file-count') { const count = (await walk(root, test.dir)).filter(path => path.endsWith(test.extension)).length; return { name: test.name, passed: count >= test.min, output: `${count}/${test.min}` }; }
  const matched = await files(root, test.dir, test.extensions);
  for (const path of matched) {
    const body = await readFile(path, 'utf-8');
    if (test.type === 'file-contains-substring' && body.includes(test.substring)) return { name: test.name, passed: true, output: path };
    if (test.type === 'file-contains-regex' && new RegExp(test.regex).test(body)) return { name: test.name, passed: true, output: path };
  }
  return { name: test.name, passed: false, output: matched.length === 0 ? `No files found in ${test.dir}` : undefined };
}

export async function runAcceptanceTests(root: string, tests: AcceptanceTest[]): Promise<Result<BenchmarkResult['acceptanceTests']>> {
  const results: BenchmarkResult['acceptanceTests'] = [];
  try { for (const test of tests) results.push(await run(root, test)); return ok(results); }
  catch { return err('TRANSPORT_ERROR', `Acceptance tests failed for ${root}`); }
}
