import type { RepoInventory } from '../types/index.js';

interface SweepTask { title: string; description: string; editableFiles: string[]; dedupeKey: string; }

const MAX_FILE_LINES = 150;
const RESULT_RATIO_FLOOR = 0.8;
const TEST_RATIO_FLOOR = 0.3;
const TEST_FILE = /(\.test|\.spec)\.[cm]?[jt]sx?$|_test\.py$/;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py)$/;
const ratio = (part: number, total: number) => (total === 0 ? 1 : part / total);
const percent = (value: number) => `${Math.round(value * 100)}%`;
const codeGlobs = (inventory: RepoInventory) => [...new Set(inventory.packages.length === 0 ? ['src/**/*'] : inventory.packages.map(pkg => pkg.path === '.' ? 'src/**/*' : `${pkg.path}/**/*`))];
const sourceCount = (inventory: RepoInventory) => inventory.files.filter(file => /(^|\/)src\//.test(file.path) && SOURCE_FILE.test(file.path) && !TEST_FILE.test(file.path) && !file.path.endsWith('.d.ts')).length;
const testCount = (inventory: RepoInventory) => inventory.files.filter(file => TEST_FILE.test(file.path)).length;

function patternTasks(inventory: RepoInventory): SweepTask[] {
  const total = inventory.patterns.resultCount + inventory.patterns.tryCatchCount;
  const resultRatio = ratio(inventory.patterns.resultCount, total);
  if (resultRatio >= RESULT_RATIO_FLOOR) return [];
  return [{
    title: 'Reduce try/catch drift toward Result<T>',
    description: `Result< usage is ${percent(resultRatio)} of Result< + try/catch occurrences (${inventory.patterns.resultCount} vs ${inventory.patterns.tryCatchCount}). Restore the Ring 2 floor of 80%.`,
    editableFiles: codeGlobs(inventory),
    dedupeKey: 'sweep:pattern-drift',
  }];
}

function coverageTasks(inventory: RepoInventory): SweepTask[] {
  const sources = sourceCount(inventory), tests = testCount(inventory), testRatio = ratio(tests, sources);
  if (testRatio >= TEST_RATIO_FLOOR) return [];
  return [{
    title: 'Raise test coverage ratio for source files',
    description: `Test coverage ratio is ${tests}/${sources} (${percent(testRatio)}). Restore the Ring 2 floor of 30% by adding focused tests.`,
    editableFiles: codeGlobs(inventory),
    dedupeKey: 'sweep:test-coverage',
  }];
}

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
    description: `${path} is now over ${MAX_FILE_LINES} lines. Decide whether to split it or record why it stays large.`,
    editableFiles: [path, 'ARCHITECTURE.md', 'AGENTS.md'],
    dedupeKey: `sweep:oversized:${path}`,
  }));
  return [...moduleTasks, ...envTasks, ...oversizedTasks, ...patternTasks(inventory), ...coverageTasks(inventory)];
}
