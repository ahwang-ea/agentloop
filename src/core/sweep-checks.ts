import type { RepoInventory } from '../types/index.js';

interface SweepTask { title: string; description: string; editableFiles: string[]; dedupeKey: string; }

export function findSweepTasks(
  agentsMd: string, architectureMd: string, inventory: RepoInventory, previous?: RepoInventory,
): SweepTask[] {
  const docs = `${agentsMd}\n${architectureMd}\n${inventory.env.example.join('\n')}`;
  const moduleTasks = inventory.packages
    .filter(pkg => pkg.path !== '.' && !agentsMd.includes(pkg.path))
    .map(pkg => ({
      title: `Document module ${pkg.name} in AGENTS.md`,
      description: `${pkg.path} exists in the repo inventory but is not referenced in AGENTS.md. Add module ownership and examples.`,
      editableFiles: ['AGENTS.md'],
      dedupeKey: `sweep:module:${pkg.path}`,
    }));
  const undocumented = inventory.env.referenced.filter(name => !docs.includes(name));
  const envTasks = undocumented.length === 0 ? [] : [{
    title: 'Document env vars discovered in code',
    description: `These env vars are referenced but not documented: ${undocumented.join(', ')}.`,
    editableFiles: ['AGENTS.md', 'ARCHITECTURE.md', '.env.example'],
    dedupeKey: `sweep:env:${undocumented.join(',')}`,
  }];
  const before = new Set(previous?.oversizedFiles ?? []);
  const newOversized = inventory.oversizedFiles.filter(path => !before.has(path));
  const oversizedTasks = newOversized.map(path => ({
    title: `Review oversized file ${path}`,
    description: `${path} is now over 300 lines. Decide whether to split it or record why it stays large.`,
    editableFiles: [path, 'ARCHITECTURE.md', 'AGENTS.md'],
    dedupeKey: `sweep:oversized:${path}`,
  }));
  return [...moduleTasks, ...envTasks, ...oversizedTasks];
}
