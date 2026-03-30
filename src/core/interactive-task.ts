import { createInterface } from 'node:readline/promises';
import { err, ok, type Result } from '../shared/result.js';
import type { Deps } from '../orchestrator.js';
import { monorepoPackages, packageScope } from './monorepo.js';
import { readInventory, scanRepo } from './scanner.js';

const summarizeTask = (input: string) => {
  const oneLine = input.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 72 ? oneLine : `${oneLine.slice(0, 69).trimEnd()}...`;
};

async function packagePaths(repoPath: string) {
  const inventory = await readInventory(repoPath); if (!inventory.ok) return inventory;
  const loaded = inventory.value ? ok(inventory.value) : await scanRepo(repoPath);
  return loaded.ok ? ok(monorepoPackages(loaded.value)) : loaded;
}

export async function enqueueInteractiveTask(deps: Deps): Promise<Result<void>> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return err('CONFIG_ERROR', 'Interactive mode requires a TTY');
  const packages = await packagePaths(deps.config.repoPath); if (!packages.ok) return packages;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const description = (await rl.question('What should agentloop build? ')).trim();
    if (!description) return err('CONFIG_ERROR', 'No task provided');
    const packagePath = packages.value.length === 0 ? undefined : (await rl.question(`Which package should this task edit? (${packages.value.join(', ')}) `)).trim();
    if (packages.value.length > 0 && (!packagePath || !packages.value.includes(packagePath))) {
      return err('CONFIG_ERROR', `Monorepo tasks must target one package: ${packages.value.join(', ')}`);
    }
    const added = await deps.queue.add({
      title: summarizeTask(description),
      description,
      scope: { editableFiles: packagePath ? packageScope(packagePath) : ['**/*'], readOnlyContext: [], forbiddenFiles: [] },
      acceptanceCriteria: [],
      priority: 'medium',
      type: 'implement',
    });
    if (!added.ok) return added;
    console.log(`Queued: ${added.value.title}`);
    return ok(undefined);
  } catch (e) {
    return err('TRANSPORT_ERROR', `Interactive input failed: ${e instanceof Error ? e.message : 'unknown error'}`);
  } finally { rl.close(); }
}
