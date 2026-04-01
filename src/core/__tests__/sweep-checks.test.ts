import { findSweepTasks } from '../sweep-checks.js';

const inventory = (overrides: Partial<Parameters<typeof findSweepTasks>[2]>) => ({
  scannedAt: '',
  files: [],
  monorepo: true,
  packages: [{ name: 'root', path: '.' }, { name: '@app/orders', path: 'packages/orders' }],
  crossPackageImports: [],
  patterns: { resultCount: 0, tryCatchCount: 0, serviceFileCount: 0, controllerFileCount: 0 },
  tests: { frameworks: [], count: 0 },
  docs: [],
  dependencies: [],
  env: { example: [], referenced: ['API_KEY'], missingInExample: [], unusedInExample: [] },
  oversizedFiles: [],
  ci: [],
  importFrequency: [],
  ...overrides,
});

test('finds missing module docs, env docs, and new oversized files', () => {
  const tasks = findSweepTasks('# AGENTS', '# ARCH', inventory({ oversizedFiles: ['src/big.ts'] }), inventory({}));
  expect(tasks.map(task => task.title)).toContain('Document module @app/orders in AGENTS.md');
  expect(tasks.map(task => task.title)).toContain('Document env vars discovered in code');
  expect(tasks.map(task => task.title)).toContain('Review oversized file src/big.ts');
  expect(tasks.find(task => task.title === 'Review oversized file src/big.ts')?.description).toContain('150 lines');
});

test('finds pattern drift when Result<T> falls below the Ring 2 floor', () => {
  const tasks = findSweepTasks('# AGENTS packages/orders', '# ARCH API_KEY', inventory({
    packages: [{ name: 'root', path: '.' }],
    patterns: { resultCount: 1, tryCatchCount: 4, serviceFileCount: 0, controllerFileCount: 0 },
  }));
  expect(tasks.map(task => task.title)).toContain('Reduce try/catch drift toward Result<T>');
});

test('finds low test coverage ratio for source files', () => {
  const tasks = findSweepTasks('# AGENTS packages/orders', '# ARCH API_KEY', inventory({
    packages: [{ name: 'root', path: '.' }],
    files: [{ path: 'src/a.ts', lines: 1 }, { path: 'src/b.ts', lines: 1 }, { path: 'src/c.ts', lines: 1 }],
  }));
  expect(tasks.map(task => task.title)).toContain('Raise test coverage ratio for source files');
});
