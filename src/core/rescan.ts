import { ok, type Result } from '../shared/result.js';
import type { RepoInventory } from '../types/index.js';
import { diffInventories } from './inventory-diff.js';
import { readInventory, writeInventory } from './scanner.js';

const summary = (before: RepoInventory | undefined, after: RepoInventory) => {
  if (!before) return `Initial inventory created with ${after.files.length} files.`;
  const delta = diffInventories(before, after), growth = delta.grownFiles.map(file => `${file.path} ${file.before}->${file.after}`).join(', ') || 'none';
  return [
    `Rescanned ${after.files.length} files into .agentloop/inventory.json`,
    `New modules: ${delta.newModules.join(', ') || 'none'}`,
    `New dependencies: ${delta.newDependencies.join(', ') || 'none'}`,
    `New env vars: ${delta.newEnvVars.join(', ') || 'none'}`,
    `Constraint changes: ${delta.constraintChanges.join('; ') || 'none'}`,
    `Grown files: ${growth}`,
  ].join('\n');
};

export async function runRescan(repoPath: string): Promise<Result<string>> {
  const before = await readInventory(repoPath); if (!before.ok) return before;
  const after = await writeInventory(repoPath); if (!after.ok) return after;
  return ok(summary(before.value, after.value));
}
