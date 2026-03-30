import { findSweepTasks } from '../sweep-checks.js';

test('finds missing module docs, env docs, and new oversized files', () => {
  const previous = {
    scannedAt: '', files: [], monorepo: true,
    packages: [{ name: 'root', path: '.' }, { name: '@app/orders', path: 'packages/orders' }],
    crossPackageImports: [], patterns: { resultCount: 0, tryCatchCount: 0, serviceFileCount: 0, controllerFileCount: 0 },
    tests: { frameworks: [], count: 0 }, docs: [], dependencies: [],
    env: { example: [], referenced: ['API_KEY'], missingInExample: [], unusedInExample: [] }, oversizedFiles: [], ci: [], importFrequency: [],
  };
  const current = { ...previous, oversizedFiles: ['src/big.ts'] };
  const tasks = findSweepTasks('# AGENTS', '# ARCH', current, previous);
  expect(tasks.map(task => task.title)).toContain('Document module @app/orders in AGENTS.md');
  expect(tasks.map(task => task.title)).toContain('Document env vars discovered in code');
  expect(tasks.map(task => task.title)).toContain('Review oversized file src/big.ts');
});
