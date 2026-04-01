import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { err, ok, type Result } from '../shared/result.js';
import { clearStaleLock } from './stale-lock.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function withArtifactLock<T>(path: string, name: string, run: () => Promise<Result<T>>): Promise<Result<T>> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const stale = await clearStaleLock(lock); if (!stale.ok) return stale;
  for (let i = 0; i < 100; i++) {
    try { await mkdir(lock); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return err('TRANSPORT_ERROR', `Cannot lock ${path}`);
      if (i === 99) return err('SESSION_ERROR', `Timed out waiting for ${name} lock ${lock}`);
      await sleep(50);
    }
  }
  try { return await run(); } finally { await rm(lock, { recursive: true, force: true }); }
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
