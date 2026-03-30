import { shouldRunSmartInit } from '../smart-init.js';

test('smart init runs only when source files exist', () => {
  expect(shouldRunSmartInit({
    scannedAt: '', files: [{ path: 'package.json', lines: 1 }, { path: 'src/app.ts', lines: 10 }], monorepo: false, packages: [], crossPackageImports: [],
    patterns: { resultCount: 0, tryCatchCount: 0, serviceFileCount: 0, controllerFileCount: 0 }, tests: { frameworks: [], count: 0 }, docs: [], dependencies: [],
    env: { example: [], referenced: [], missingInExample: [], unusedInExample: [] }, oversizedFiles: [], ci: [], importFrequency: [],
  })).toBe(true);
  expect(shouldRunSmartInit({
    scannedAt: '', files: [{ path: 'package.json', lines: 1 }, { path: '.claude/settings.json', lines: 1 }], monorepo: false, packages: [], crossPackageImports: [],
    patterns: { resultCount: 0, tryCatchCount: 0, serviceFileCount: 0, controllerFileCount: 0 }, tests: { frameworks: [], count: 0 }, docs: [], dependencies: [],
    env: { example: [], referenced: [], missingInExample: [], unusedInExample: [] }, oversizedFiles: [], ci: [], importFrequency: [],
  })).toBe(false);
});
