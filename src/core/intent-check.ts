import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ok, err, type Result } from '../shared/result.js';
import type { AgentloopConfig, NotifierAdapter, RepoInventory } from '../types/index.js';
import { diffInventories, formatIntentSummary } from './inventory-diff.js';
import { scanRepo } from './scanner.js';
import { baseWorktreePath } from './worktree.js';

const baselinePath = (repoPath: string) => join(repoPath, '.agentloop', 'intent-baseline.json');

async function readBaseline(repoPath: string): Promise<Result<RepoInventory | undefined>> {
  try { return ok(JSON.parse(await readFile(baselinePath(repoPath), 'utf-8')) as RepoInventory); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ok(undefined);
    return err('TRANSPORT_ERROR', `Cannot read ${baselinePath(repoPath)}`);
  }
}
async function writeBaseline(repoPath: string, inventory: RepoInventory): Promise<Result<void>> {
  try { await mkdir(join(repoPath, '.agentloop'), { recursive: true }); await writeFile(baselinePath(repoPath), JSON.stringify(inventory, null, 2), 'utf-8'); return ok(undefined); }
  catch { return err('TRANSPORT_ERROR', `Cannot write ${baselinePath(repoPath)}`); }
}

export async function ensureIntentBaseline(repoPath: string, inventory: RepoInventory): Promise<Result<void>> {
  const baseline = await readBaseline(repoPath); if (!baseline.ok) return baseline;
  return baseline.value ? ok(undefined) : writeBaseline(repoPath, inventory);
}

export async function runIntentCheck(
  config: AgentloopConfig, notifier: NotifierAdapter, feature: string, mergeCommit: string,
): Promise<Result<void>> {
  const baseline = await readBaseline(config.repoPath); if (!baseline.ok) return baseline;
  const current = await scanRepo(baseWorktreePath(config, config.baseBranch)); if (!current.ok) return current;
  const delta = diffInventories(baseline.value ?? current.value, current.value);
  const sent = await notifier.send({
    type: 'intent-check',
    summary: `Feature ${feature} complete`,
    details: formatIntentSummary(delta),
    timestamp: new Date().toISOString(),
    idempotencyKey: `intent:${feature}:${mergeCommit}`,
  });
  if (!sent.ok) return sent;
  return writeBaseline(config.repoPath, current.value);
}
