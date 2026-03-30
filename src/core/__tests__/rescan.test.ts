import { diffInventories } from '../inventory-diff.js';

test('reports grown files and constraint changes in rescans', () => {
  const delta = diffInventories(
    { scannedAt: '', files: [{ path: 'src/a.ts', lines: 10 }], monorepo: false, packages: [], crossPackageImports: [], patterns: { resultCount: 0, tryCatchCount: 0, serviceFileCount: 0, controllerFileCount: 0 }, tests: { frameworks: [], count: 0 }, docs: [], dependencies: [], env: { example: [], referenced: [], missingInExample: [], unusedInExample: [] }, oversizedFiles: [], ci: [], importFrequency: [] },
    { scannedAt: '', files: [{ path: 'src/a.ts', lines: 20 }], monorepo: true, packages: [], crossPackageImports: ['a -> b'], patterns: { resultCount: 0, tryCatchCount: 0, serviceFileCount: 0, controllerFileCount: 0 }, tests: { frameworks: ['vitest'], count: 0 }, docs: [], dependencies: [], env: { example: [], referenced: [], missingInExample: [], unusedInExample: [] }, oversizedFiles: [], ci: ['.github/workflows/ci.yml'], importFrequency: [] },
  );
  expect(delta.grownFiles[0]?.after).toBe(20);
  expect(delta.constraintChanges).toContain('Monorepo mode enabled');
  expect(delta.constraintChanges).toContain('New cross-package dependency: a -> b');
});
