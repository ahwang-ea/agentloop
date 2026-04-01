import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DiscoveredRepoFile } from '../scanner-discovery.js';
import { buildInventory } from '../scanner-inventory.js';

const tempDirs: string[] = [];
const repo = async () => {
  const path = await mkdtemp(join(tmpdir(), 'agentloop-scan-inventory-'));
  tempDirs.push(path);
  return path;
};
const lines = (count: number) => Array.from({ length: count }, (_, index) => `export const line${index} = ${index};`).join('\n');
const file = (path: string, body: string, modifiedAt?: string): DiscoveredRepoFile => ({ path, body, lines: body ? body.split('\n').length : 0, modifiedAt });
const write = async (root: string, path: string, body: string) => {
  await mkdir(join(root, dirname(path)), { recursive: true });
  await writeFile(join(root, path), body, 'utf-8');
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

test('builds inventory with direct helper coverage for env, imports, deps, and size limits', async () => {
  const root = await repo();
  const discovered = [
    file('package.json', JSON.stringify({ name: 'root-app', workspaces: ['packages/*'], dependencies: { jest: '^1.0.0' } })),
    file('packages/orders/package.json', JSON.stringify({ name: '@app/orders' })),
    file('packages/shared/package.json', JSON.stringify({ name: '@app/shared' })),
    file('packages/shared/src/util.ts', 'export const util = (value: unknown) => value;'),
    file('pyproject.toml', '[tool.poetry.dependencies]\npython = "^3.12"\npytest = "^8.0.0"\nrequests = "^2.32.0"'),
    file('.env.example', 'API_KEY=1\nUNUSED=1'),
    file('.env.sample', 'WEB_URL=https://example.test'),
    file('README.md', '# Docs', '2026-04-01T00:00:00.000Z'),
    file('.github/workflows/ci.yml', 'name: ci'),
    file('packages/orders/src/orders.controller.ts', [
      "import { util } from '../../shared/src/util';",
      "import shared from '@app/shared';",
      "const value: Result<string> = ok('x');",
      'try {',
      '  util(shared);',
      '} catch (error) {',
      '  return error;',
      '}',
      'process.env.API_KEY;',
      'import.meta.env.WEB_URL;',
    ].join('\n')),
    file('packages/orders/src/orders.service.ts', [
      "const { util } = require('../../shared/src/util');",
      "os.getenv('PY_TOKEN');",
      'export const service = () => util;',
    ].join('\n')),
    file('packages/orders/src/limit.ts', lines(150)),
    file('packages/orders/src/too-big.ts', lines(151)),
    file('src/api.test.ts', "test('x', () => expect(true).toBe(true));"),
    file('scripts/cli_test.py', "def test_cli():\n    return os.getenv('CLI_TOKEN')"),
  ];

  await Promise.all(discovered.map(item => write(root, item.path, item.body)));
  const inventory = await buildInventory(root, discovered);

  expect(inventory.version).toBe(1);
  expect(inventory.monorepo).toBe(true);
  expect(inventory.packages).toEqual([
    { name: 'root-app', path: '.' },
    { name: '@app/orders', path: 'packages/orders' },
    { name: '@app/shared', path: 'packages/shared' },
  ]);
  expect(inventory.crossPackageImports).toEqual(['@app/orders -> @app/shared']);
  expect(inventory.patterns).toEqual({ resultCount: 1, tryCatchCount: 2, serviceFileCount: 1, controllerFileCount: 1 });
  expect(inventory.tests).toEqual({ frameworks: ['jest', 'pytest'], count: 2 });
  expect(inventory.env.referenced).toEqual(['API_KEY', 'CLI_TOKEN', 'PY_TOKEN', 'WEB_URL']);
  expect(inventory.env.missingInExample).toEqual(['CLI_TOKEN', 'PY_TOKEN']);
  expect(inventory.env.unusedInExample).toEqual(['UNUSED']);
  expect(inventory.oversizedFiles).toEqual(['packages/orders/src/too-big.ts']);
  expect(inventory.ci).toEqual(['.github/workflows/ci.yml']);
  expect(inventory.importFrequency).toEqual([{ path: 'packages/shared/src/util.ts', importedBy: 2 }]);
  expect(inventory.docs).toEqual([{ path: 'README.md', modifiedAt: '2026-04-01T00:00:00.000Z' }]);
  expect(inventory.dependencies).toEqual(expect.arrayContaining([
    { path: 'package.json', kind: 'package.json', dependencies: ['jest'] },
    { path: 'pyproject.toml', kind: 'pyproject.toml', dependencies: ['pytest', 'requests'] },
  ]));
});


test('keeps complex pyproject dependency names and drops structural tokens', async () => {
  const root = await repo();
  const inventory = await buildInventory(root, [file('pyproject.toml', [
    '[tool.poetry.dependencies]',
    'python = "^3.11"',
    'requests = "^2.31"',
    '',
    '[project]',
    'dependencies = [',
    '  "requests>=2",',
    `  'typing-extensions>=4; python_version < "3.13"',`,
    '  "pytest>=8",',
    ']',
  ].join('\n'))]);
  expect(inventory.dependencies).toEqual([{ path: 'pyproject.toml', kind: 'pyproject.toml', dependencies: ['requests', 'typing-extensions', 'pytest'] }]);
});
