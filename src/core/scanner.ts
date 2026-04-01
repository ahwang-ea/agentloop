import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from '../shared/result.js';
import { parseInventory } from './inventory-parse.js';
import type { RepoInventory } from '../types/index.js';
import { discoverRepoFiles } from './scanner-discovery.js';
import { buildInventory } from './scanner-inventory.js';

export async function scanRepo(repoPath: string): Promise<Result<RepoInventory>> {
  try {
    return ok(await buildInventory(repoPath, await discoverRepoFiles(repoPath)));
  } catch (e) { return err('TRANSPORT_ERROR', `Scanner failed: ${e instanceof Error ? e.message : 'unknown error'}`); }
}

export async function writeInventory(repoPath: string): Promise<Result<RepoInventory>> {
  const inventory = await scanRepo(repoPath);
  if (!inventory.ok) return inventory;
  try {
    await mkdir(join(repoPath, '.agentloop'), { recursive: true });
    await writeFile(join(repoPath, '.agentloop', 'inventory.json'), JSON.stringify(inventory.value, null, 2), 'utf-8');
    return inventory;
  } catch (e) { return err('TRANSPORT_ERROR', `Cannot write inventory.json: ${e instanceof Error ? e.message : 'unknown error'}`); }
}

export async function readInventory(repoPath: string): Promise<Result<RepoInventory | undefined>> {
  const path = join(repoPath, '.agentloop', 'inventory.json');
  try { return parseInventory(await readFile(path, 'utf-8'), path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ok(undefined);
    return err('TRANSPORT_ERROR', `Cannot read inventory.json: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
}
