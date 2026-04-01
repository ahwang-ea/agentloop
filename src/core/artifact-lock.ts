import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { err, ok, type Result } from '../shared/result.js';
import { clearStaleLock } from './stale-lock.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const lockError = (path: string) => err('TRANSPORT_ERROR', `Cannot lock ${path}`);

async function takeArtifactLock(path: string, name: string, wait: boolean): Promise<Result<string | null>> {
  const lock = `${path}.lock`;
  try { await mkdir(dirname(path), { recursive: true }); } catch { return lockError(path); }
  const stale = await clearStaleLock(lock); if (!stale.ok) return stale;
  for (let i = 0; i < 100; i++) {
    try { await mkdir(lock); return ok(lock); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return lockError(path);
      if (!wait) return ok(null);
      if (i === 99) return err('SESSION_ERROR', `Timed out waiting for ${name} lock ${lock}`);
      await sleep(50);
    }
  }
  return ok(null);
}

export async function withArtifactLock<T>(path: string, name: string, run: () => Promise<Result<T>>): Promise<Result<T>> {
  const taken = await takeArtifactLock(path, name, true); if (!taken.ok) return taken;
  if (!taken.value) return err('SESSION_ERROR', `Timed out waiting for ${name} lock ${path}.lock`);
  try { return await run(); } finally { await rm(taken.value, { recursive: true, force: true }); }
}

export async function tryWithArtifactLock<T>(path: string, name: string, run: () => Promise<Result<T>>): Promise<Result<T | null>> {
  const taken = await takeArtifactLock(path, name, false); if (!taken.ok) return taken;
  if (!taken.value) return ok(null);
  try { return await run(); } finally { await rm(taken.value, { recursive: true, force: true }); }
}

export async function writeTextAtomically(path: string, text: string): Promise<Result<void>> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, text, 'utf-8');
    await rename(temp, path);
    return ok(undefined);
  } catch (e) {
    return err('TRANSPORT_ERROR', `Cannot write ${path}: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
}
