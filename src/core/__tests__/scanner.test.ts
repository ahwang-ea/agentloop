import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { discoverRepoFiles, resolveRepoImport } from '../scanner-discovery.js';
import { buildInventory } from '../scanner-inventory.js';
import { readInventory, writeInventory } from '../scanner.js';

const roots: string[] = [];
const repo = async () => { const root = await mkdtemp(join(tmpdir(), 'agentloop-scan-')); roots.push(root); return root; };
const lines = (count: number) => Array.from({ length: count }, (_, index) => `export const line${index} = ${index};`).join('\n');

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test('discovers repo files while ignoring generated dirs and resolves imports', async () => {
  const root = await repo();
  await Promise.all([
    mkdir(join(root, 'src', 'dir'), { recursive: true }),
    mkdir(join(root, '.git'), { recursive: true }),
    mkdir(join(root, '.agentloop'), { recursive: true }),
    mkdir(join(root, '.context'), { recursive: true }),
    mkdir(join(root, 'dist'), { recursive: true }),
    mkdir(join(root, 'node_modules'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, 'README.md'), '# Repo', 'utf-8'),
    writeFile(join(root, 'src', 'main.ts'), 'import "./dir/index";\nimport "./util";', 'utf-8'),
    writeFile(join(root, 'src', 'dir', 'index.ts'), 'export const dir = 1;', 'utf-8'),
    writeFile(join(root, 'src', 'util.ts'), 'export const util = 1;', 'utf-8'),
    writeFile(join(root, '.git', 'ignored.ts'), 'ignored', 'utf-8'),
    writeFile(join(root, '.agentloop', 'ignored.json'), '{}', 'utf-8'),
    writeFile(join(root, '.context', 'ignored.md'), 'ignored', 'utf-8'),
    writeFile(join(root, 'dist', 'ignored.js'), 'ignored', 'utf-8'),
    writeFile(join(root, 'node_modules', 'ignored.js'), 'ignored', 'utf-8'),
  ]);
  const files = await discoverRepoFiles(root);
  expect(files.map(file => file.path).sort()).toEqual(['README.md', 'src/dir/index.ts', 'src/main.ts', 'src/util.ts']);
  expect(files.find(file => file.path === 'README.md')?.modifiedAt).toBeDefined();
  expect(files.find(file => file.path === 'src/main.ts')?.lines).toBe(2);
  expect(await resolveRepoImport(root, 'src/main.ts', './util')).toBe('src/util.ts');
  expect(await resolveRepoImport(root, 'src/main.ts', './dir/index')).toBe('src/dir/index.ts');
  expect(await resolveRepoImport(root, 'src/main.ts', 'react')).toBeUndefined();
});

test('builds helper inventory with env, imports, dependencies, and 150-line limits', async () => {
  const root = await repo();
  await Promise.all([
    mkdir(join(root, '.github', 'workflows'), { recursive: true }),
    mkdir(join(root, 'packages', 'app', 'src'), { recursive: true }),
    mkdir(join(root, 'packages', 'shared', 'src'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'], devDependencies: { vitest: '^1.0.0' } }), 'utf-8'),
    writeFile(join(root, 'packages', 'app', 'package.json'), JSON.stringify({ name: '@app/app' }), 'utf-8'),
    writeFile(join(root, 'packages', 'shared', 'package.json'), JSON.stringify({ name: '@app/shared' }), 'utf-8'),
    writeFile(join(root, '.env.example'), 'API_KEY=1\nUNUSED=1', 'utf-8'),
    writeFile(join(root, '.env.sample'), 'MODE=1', 'utf-8'),
    writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'name: ci', 'utf-8'),
    writeFile(join(root, 'packages', 'shared', 'src', 'util.ts'), 'export const util = 1;', 'utf-8'),
    writeFile(join(root, 'packages', 'app', 'src', 'main.ts'), 'import { util } from "../../shared/src/util";\nconst value: Result<string> = ok("x");\nprocess.env.API_KEY;\nimport.meta.env.MODE;', 'utf-8'),
    writeFile(join(root, 'packages', 'app', 'src', 'consumer.ts'), 'const util = require("../../shared/src/util");\nos.getenv("SECRET_TOKEN");', 'utf-8'),
    writeFile(join(root, 'packages', 'app', 'src', 'limit.ts'), lines(150), 'utf-8'),
    writeFile(join(root, 'packages', 'app', 'src', 'too-big.ts'), lines(151), 'utf-8'),
  ]);
  const inventory = await buildInventory(root, await discoverRepoFiles(root));
  expect(inventory.monorepo).toBe(true);
  expect(inventory.dependencies.find(file => file.path === 'package.json')?.dependencies).toContain('vitest');
  expect(inventory.tests.frameworks).toContain('vitest');
  expect(inventory.crossPackageImports).toContain('@app/app -> @app/shared');
  expect(inventory.importFrequency).toContainEqual({ path: 'packages/shared/src/util.ts', importedBy: 2 });
  expect(inventory.env.example).toEqual(['API_KEY', 'MODE', 'UNUSED']);
  expect(inventory.env.referenced).toEqual(['API_KEY', 'MODE', 'SECRET_TOKEN']);
  expect(inventory.env.missingInExample).toEqual(['SECRET_TOKEN']);
  expect(inventory.env.unusedInExample).toEqual(['UNUSED']);
  expect(inventory.oversizedFiles).toEqual(['packages/app/src/too-big.ts']);
  expect(inventory.ci).toEqual(['.github/workflows/ci.yml']);
});

test('writes repo inventory with patterns, tests, and env mismatches', async () => {
  const root = await repo();
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { jest: '^1.0.0' } }), 'utf-8');
  await writeFile(join(root, '.env.example'), 'API_KEY=1\nUNUSED=1\n', 'utf-8');
  await writeFile(join(root, 'src', 'orders.service.ts'), 'import { helper } from "./helper";\nconst x: Result<string> = ok("x");\nprocess.env.API_KEY;\n', 'utf-8');
  await writeFile(join(root, 'src', 'helper.ts'), 'export const helper = 1;\n', 'utf-8');
  await writeFile(join(root, 'src', 'orders.test.ts'), 'test("x", () => expect(true).toBe(true));\n', 'utf-8');
  await writeFile(join(root, 'src', 'limit.ts'), lines(150), 'utf-8');
  await writeFile(join(root, 'src', 'too-big.ts'), lines(151), 'utf-8');
  const result = await writeInventory(root);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const written = JSON.parse(await readFile(join(root, '.agentloop', 'inventory.json'), 'utf-8')) as typeof result.value;
  expect(written.tests.count).toBe(1);
  expect(written.tests.frameworks).toContain('jest');
  expect(written.patterns.serviceFileCount).toBe(1);
  expect(written.importFrequency[0]?.path).toBe('src/helper.ts');
  expect(written.env.unusedInExample).toContain('UNUSED');
  expect(written.oversizedFiles).toEqual(['src/too-big.ts']);
});

test('round-trips raw-root inventories through writeInventory and readInventory', async () => {
  const root = await repo();
  await mkdir(join(root, 'src'), { recursive: true });
  await Promise.all([writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo' }), 'utf-8'), writeFile(join(root, 'src', 'main.ts'), 'export const main = 1;', 'utf-8')]);
  const written = await writeInventory(root), read = await readInventory(root);
  expect(written.ok).toBe(true); expect(read.ok).toBe(true);
  if (!written.ok || !read.ok || !read.value) return;
  expect(read.value).toEqual(written.value);
});

test('falls back from malformed package.json and extracts pyproject dependency names', async () => {
  const root = await repo();
  await Promise.all([writeFile(join(root, 'package.json'), '{ nope', 'utf-8'), writeFile(join(root, 'pyproject.toml'), '[tool.poetry.dependencies]\npython = "^3.11"\nrequests = "^2.31"\n\n[project]\ndependencies = [\n  "requests>=2",\n  "typing-extensions>=4; python_version < "3.13"",\n  "pytest>=8",\n  "requests>=2",\n]\n', 'utf-8')]);
  const inventory = await buildInventory(root, await discoverRepoFiles(root)), pyproject = inventory.dependencies.find(file => file.path === 'pyproject.toml');
  expect(inventory.packages).toEqual([]); expect(inventory.dependencies).toHaveLength(1);
  expect(pyproject?.dependencies).toEqual(['requests', 'typing-extensions', 'pytest']);
  expect(inventory.tests.frameworks).toEqual(['pytest']);
});

test('reads versioned inventory wrappers', async () => {
  const root = await repo();
  await mkdir(join(root, '.agentloop'), { recursive: true });
  await writeFile(join(root, '.agentloop', 'inventory.json'), JSON.stringify({
    version: 1,
    inventory: {
      scannedAt: '2026-04-01T00:00:00.000Z', files: [], monorepo: false, packages: [], crossPackageImports: [],
      patterns: { resultCount: 0, tryCatchCount: 0, serviceFileCount: 0, controllerFileCount: 0 },
      tests: { frameworks: [], count: 0 }, docs: [], dependencies: [],
      env: { example: [], referenced: [], missingInExample: [], unusedInExample: [] }, oversizedFiles: [], ci: [], importFrequency: [],
    },
  }), 'utf-8');
  const read = await readInventory(root);
  expect(read.ok).toBe(true);
  if (!read.ok || !read.value) return;
  expect(read.value.version).toBe(1);
});
