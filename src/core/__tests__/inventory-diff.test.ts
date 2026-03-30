import { diffInventories, formatIntentSummary, needsArchitectureUpdate } from '../inventory-diff.js';

const inventory = (overrides: Partial<Parameters<typeof diffInventories>[0]>) => ({
  scannedAt: '',
  files: [{ path: 'src/a.ts', lines: 10 }],
  monorepo: false,
  packages: [{ name: 'root', path: '.' }],
  crossPackageImports: [],
  patterns: { resultCount: 0, tryCatchCount: 0, serviceFileCount: 0, controllerFileCount: 0 },
  tests: { frameworks: [], count: 0 },
  docs: [],
  dependencies: [{ path: 'package.json', kind: 'package.json' as const, dependencies: ['jest'] }],
  env: { example: [], referenced: ['API_KEY'], missingInExample: [], unusedInExample: [] },
  oversizedFiles: [],
  ci: [],
  importFrequency: [],
  ...overrides,
});

test('diffs inventories for docs and intent summaries', () => {
  const delta = diffInventories(inventory({}), inventory({
    files: [{ path: 'src/a.ts', lines: 20 }],
    packages: [{ name: 'root', path: '.' }, { name: 'orders', path: 'packages/orders' }],
    dependencies: [{ path: 'package.json', kind: 'package.json', dependencies: ['jest', 'zod'] }],
    env: { example: [], referenced: ['API_KEY', 'ORDER_ENV'], missingInExample: [], unusedInExample: [] },
    crossPackageImports: ['orders -> shared'],
    ci: ['.github/workflows/ci.yml'],
    tests: { frameworks: ['vitest'], count: 1 },
    monorepo: true,
  }));
  expect(needsArchitectureUpdate(delta)).toBe(true);
  expect(delta.newModules).toContain('packages/orders');
  expect(delta.newDependencies).toContain('zod');
  expect(delta.constraintChanges).toContain('Monorepo mode enabled');
  expect(delta.constraintChanges).toContain('New cross-package dependency: orders -> shared');
  expect(formatIntentSummary(delta)).toContain('Constraint changes:');
  expect(formatIntentSummary(delta)).toContain('Still aligned with your goals?');
});
