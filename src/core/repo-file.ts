import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { ok, err, type Result } from '../shared/result.js';

export const repoFilePath = (repoPath: string, path?: string) => !path ? undefined : isAbsolute(path) ? path : join(repoPath, path);

export async function readRepoFile(repoPath: string, path?: string): Promise<Result<string | undefined>> {
  const file = repoFilePath(repoPath, path); if (!file) return ok(undefined);
  try { return ok(await readFile(file, 'utf-8')); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? ok(undefined) : err('TRANSPORT_ERROR', `Cannot read ${file}`);
  }
}
