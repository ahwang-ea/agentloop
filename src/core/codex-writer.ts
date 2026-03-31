import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { err, ok, type Result } from '../shared/result.js';
import type { CodexWriterAdapter, WriterOutput } from '../types/index.js';

const exec = promisify(execFile);
const uniq = (items: string[]) => [...new Set(items.filter(Boolean))].sort();
const text = (e: unknown) => {
  const x = e as { stdout?: string; stderr?: string; message?: string };
  return `${x.stdout ?? ''}${x.stderr ?? ''}`.trim() || x.message || 'Codex CLI failed';
};
const codexTimeoutMs = () => {
  const value = Number(process.env.AGENTLOOP_CODEX_TIMEOUT_MS ?? 8 * 60_000);
  return Number.isFinite(value) && value > 0 ? value : 8 * 60_000;
};
async function changedFiles(cwd: string): Promise<Result<string[]>> {
  try {
    const [tracked, untracked] = await Promise.all([
      exec('git', ['diff', '--name-only', '--relative'], { cwd }),
      exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd }),
    ]);
    return ok(uniq(`${tracked.stdout}\n${untracked.stdout}`.split('\n')));
  } catch (e) {
    return err('TRANSPORT_ERROR', `Cannot read Codex diff: ${text(e)}`);
  }
}
async function readOutput(path: string): Promise<string> {
  try { return await readFile(path, 'utf-8'); }
  catch { return ''; }
}

export async function verifyCodexCli(): Promise<Result<void>> {
  try { await exec('codex', ['--version']); return ok(undefined); }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? err('CONFIG_ERROR', 'Codex CLI is required when useCodexWriter=true') : ok(undefined); }
}

export function createCodexWriterAdapter(model: string): CodexWriterAdapter {
  const run = async (prompt: string, cwd: string): Promise<Result<WriterOutput>> => {
    const dir = await mkdtemp(join(tmpdir(), 'agentloop-codex-'));
    const out = join(dir, 'last-message.txt');
    try {
      await exec('codex', ['exec', '--full-auto', '--color', 'never', '-m', model, '-C', cwd, '-o', out, prompt], { cwd, timeout: codexTimeoutMs(), maxBuffer: 10 * 1024 * 1024 });
      const files = await changedFiles(cwd); if (!files.ok) return files;
      return ok({ text: (await readOutput(out)).trim(), changedFiles: files.value, tokenEstimate: 0 });
    } catch (e) {
      return err((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'CONFIG_ERROR' : 'SESSION_ERROR', text(e));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  return { write: run, fix: run };
}
