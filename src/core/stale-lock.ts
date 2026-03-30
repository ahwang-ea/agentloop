import { rm, stat } from 'node:fs/promises';
import { ok, err, type Result } from '../shared/result.js';

const STALE_LOCK_MS = 5 * 60_000;

export async function clearStaleLock(lock: string, now = Date.now()): Promise<Result<void>> {
  try {
    const info = await stat(lock);
    if (now - info.mtimeMs < STALE_LOCK_MS) return ok(undefined);
    await rm(lock, { recursive: true, force: true });
    return ok(undefined);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? ok(undefined) : err('TRANSPORT_ERROR', `Cannot inspect lock ${lock}`);
  }
}
