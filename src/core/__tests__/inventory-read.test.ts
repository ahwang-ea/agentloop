import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import type { RepoInventory } from '../../types/index.js';
import { readInventory } from '../scanner.js';

const roots: string[] = [];
const repo = async () => { const root = await mkdtemp(join(tmpdir(), 'agentloop-inventory-read-')); roots.push(root); return root; };
const inventoryPath = (root: string) => join(root, '.agentloop', 'inventory.json');
const inventory = (): RepoInventory => ({
  scannedAt: '2026-04-01T00:00:00.000Z', files: [], monorepo: false, packages: [], crossPackageImports: [],
  patterns: { resultCount: 0, tryCatchCount: 0, serviceFileCount: 0, controllerFileCount: 0 },
  tests: { frameworks: [], count: 0 }, docs: [], dependencies: [],
  env: { example: [], referenced: [], missingInExample: [], unusedInExample: [] }, oversizedFiles: [], ci: [], importFrequency: [],
});
const writePersisted = async (root: string, raw: string) => {
  await mkdir(join(root, '.agentloop'), { recursive: true });
  await writeFile(inventoryPath(root), raw, 'utf-8');
};

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test('returns a malformed error for malformed raw-root inventories', async () => {
  const root = await repo(), path = inventoryPath(root);
  await writePersisted(root, JSON.stringify({ ...inventory(), tests: { frameworks: [], count: 'nope' } }, null, 2));
  const read = await readInventory(root);
  expect(read.ok).toBe(false);
  if (read.ok) return;
  expect(read.error.code).toBe('TRANSPORT_ERROR');
  expect(read.error.message).toBe(`Malformed ${path}: invalid inventory structure`);
});

test('returns a malformed error for malformed wrapped inventories', async () => {
  const root = await repo(), path = inventoryPath(root);
  await writePersisted(root, JSON.stringify({ version: 1, inventory: [] }, null, 2));
  const read = await readInventory(root);
  expect(read.ok).toBe(false);
  if (read.ok) return;
  expect(read.error.code).toBe('TRANSPORT_ERROR');
  expect(read.error.message).toBe(`Malformed ${path}: inventory must be an object`);
});

test('returns a malformed error for corrupt persisted inventories', async () => {
  const root = await repo(), path = inventoryPath(root);
  await writePersisted(root, '{ nope');
  const read = await readInventory(root);
  expect(read.ok).toBe(false);
  if (read.ok) return;
  expect(read.error.code).toBe('TRANSPORT_ERROR');
  expect(read.error.message).toBe(`Malformed ${path}`);
});

test('returns a transport error for unreadable persisted inventories', async () => {
  const root = await repo();
  await mkdir(inventoryPath(root), { recursive: true });
  const read = await readInventory(root);
  expect(read.ok).toBe(false);
  if (read.ok) return;
  expect(read.error.code).toBe('TRANSPORT_ERROR');
  expect(read.error.message).toContain('Cannot read inventory.json:');
});
