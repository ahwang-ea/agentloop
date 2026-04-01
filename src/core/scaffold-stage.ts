import { mkdir, readdir, rm, stat, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig } from '../types/index.js';

const hour = 60 * 60 * 1000;
const exists = async (path: string) => stat(path).then(() => true).catch(() => false);
const listFiles = async (root: string, dir = ''): Promise<string[]> => {
  const current = join(root, dir), entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.flatMap(entry => entry.isDirectory() ? listFiles(root, join(dir, entry.name)) : [Promise.resolve([join(dir, entry.name)])]));
  return nested.flat();
};

export const scaffoldStageDir = (repoPath: string, taskId: string) => join(repoPath, '.agentloop', 'scaffolds', taskId);

export async function consumeStagedScaffold(repoPath: string, taskId: string, worktreePath: string): Promise<Result<string[] | undefined>> {
  const stage = scaffoldStageDir(repoPath, taskId);
  if (!await exists(stage)) return ok(undefined);
  try {
    const files = await listFiles(stage);
    for (const file of files) {
      const dest = join(worktreePath, file);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(join(stage, file), dest);
    }
    await rm(stage, { recursive: true, force: true });
    return ok(files.sort());
  } catch (error) {
    return err('TRANSPORT_ERROR', `Cannot consume staged scaffold for ${taskId}: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

export async function cleanupStaleScaffolds(config: Pick<AgentloopConfig, 'repoPath'>, now = Date.now()): Promise<Result<void>> {
  const root = join(config.repoPath, '.agentloop', 'scaffolds');
  try {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name), age = await stat(path).then(info => now - info.mtimeMs).catch(() => 0);
      if (age > hour) await rm(path, { recursive: true, force: true });
    }
    return ok(undefined);
  } catch (error) {
    return err('TRANSPORT_ERROR', `Cannot clean staged scaffolds: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}
