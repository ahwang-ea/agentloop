import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInventory, writeInventory } from '../scanner.js';

test('writes repo inventory with patterns, tests, and env mismatches', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'agentloop-scan-'));
  await mkdir(join(repo, 'src'), { recursive: true });
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `export const line${index} = ${index};`).join('\n');
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { jest: '^1.0.0' } }), 'utf-8');
  await writeFile(join(repo, '.env.example'), 'API_KEY=1\nUNUSED=1\n', 'utf-8');
  await writeFile(join(repo, 'src', 'orders.service.ts'), 'import { helper } from "./helper";\nconst x: Result<string> = ok("x");\nprocess.env.API_KEY;\n', 'utf-8');
  await writeFile(join(repo, 'src', 'helper.ts'), 'export const helper = 1;\n', 'utf-8');
  await writeFile(join(repo, 'src', 'orders.test.ts'), 'test("x", () => expect(true).toBe(true));\n', 'utf-8');
  await writeFile(join(repo, 'src', 'limit.ts'), lines(150), 'utf-8');
  await writeFile(join(repo, 'src', 'too-big.ts'), lines(151), 'utf-8');
  const result = await writeInventory(repo);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const written = JSON.parse(await readFile(join(repo, '.agentloop', 'inventory.json'), 'utf-8')) as typeof result.value;
  expect(written.tests.count).toBe(1);
  expect(written.tests.frameworks).toContain('jest');
  expect(written.patterns.serviceFileCount).toBe(1);
  expect(written.importFrequency[0]?.path).toBe('src/helper.ts');
  expect(written.env.unusedInExample).toContain('UNUSED');
  expect(written.oversizedFiles).toEqual(['src/too-big.ts']);
});


test('reads versioned inventory wrappers', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'agentloop-scan-'));
  await mkdir(join(repo, '.agentloop'), { recursive: true });
  await writeFile(join(repo, '.agentloop', 'inventory.json'), JSON.stringify({
    version: 1,
    inventory: {
      scannedAt: '2026-04-01T00:00:00.000Z', files: [], monorepo: false, packages: [], crossPackageImports: [],
      patterns: { resultCount: 0, tryCatchCount: 0, serviceFileCount: 0, controllerFileCount: 0 },
      tests: { frameworks: [], count: 0 }, docs: [], dependencies: [],
      env: { example: [], referenced: [], missingInExample: [], unusedInExample: [] }, oversizedFiles: [], ci: [], importFrequency: [],
    },
  }), 'utf-8');
  const read = await readInventory(repo);
  expect(read.ok).toBe(true);
  if (!read.ok || !read.value) return;
  expect(read.value.version).toBe(1);
});
