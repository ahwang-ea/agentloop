import type { RepoInventory } from '../../types/index.js';
import { applyMonorepoTaskRules, packageScope, scopedPackages } from '../monorepo.js';
import { normalizeInitDrafts } from '../init-monorepo.js';

const inventory: RepoInventory = {
  scannedAt: '',
  files: [
    { path: 'packages/orders/src/index.ts', lines: 10 },
    { path: 'packages/shared/src/util.ts', lines: 5 },
  ],
  monorepo: true,
  packages: [
    { name: 'root', path: '.' },
    { name: 'orders', path: 'packages/orders' },
    { name: 'shared', path: 'packages/shared' },
  ],
  crossPackageImports: ['orders -> shared'],
  patterns: { resultCount: 0, tryCatchCount: 0, serviceFileCount: 0, controllerFileCount: 0 },
  tests: { frameworks: [], count: 0 },
  docs: [],
  dependencies: [],
  env: { example: [], referenced: [], missingInExample: [], unusedInExample: [] },
  oversizedFiles: [],
  ci: [],
  importFrequency: [],
};
const task = (editableFiles: string[], feature?: string) => ({
  title: 'Task', description: '', feature,
  scope: { editableFiles, readOnlyContext: [], forbiddenFiles: [] },
  acceptanceCriteria: [], priority: 'medium' as const,
});

test('derives package scope from monorepo paths', () => {
  expect(packageScope('packages/orders')).toEqual(['packages/orders/**/*']);
  expect(scopedPackages(['packages/orders/**/*'], inventory)).toEqual(['packages/orders']);
});

test('rejects cross-package monorepo tasks', () => {
  const result = applyMonorepoTaskRules(task(['packages/orders/**/*', 'packages/shared/**/*']), inventory);
  expect(result.ok).toBe(false);
});

test('keeps shared packages read-only for feature work', () => {
  const result = applyMonorepoTaskRules(task(['packages/orders/**/*'], 'checkout'), inventory);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.scope.forbiddenFiles).toContain('packages/shared/**/*');
  expect(result.value.scope.readOnlyContext).toContain('packages/shared/MODULE.md');
});

test('rejects feature edits in shared packages', () => {
  const result = applyMonorepoTaskRules(task(['packages/shared/**/*'], 'checkout'), inventory);
  expect(result.ok).toBe(false);
});

test('fills missing monorepo module docs and rules', () => {
  const drafts = normalizeInitDrafts(inventory, { agentsMd: '# AGENTS', architectureMd: '# ARCH', modules: [], questions: [] });
  expect(drafts.modules.map(module => module.path)).toContain('packages/orders/MODULE.md');
  expect(drafts.modules.map(module => module.path)).toContain('packages/shared/MODULE.md');
  expect(drafts.agentsMd).toContain('packages/orders/MODULE.md');
  expect(drafts.agentsMd).toContain('One task = one package.');
});
