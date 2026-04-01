import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverRepoFiles, resolveRepoImport } from '../scanner-discovery.js';

const tempDirs: string[] = [];
const repo = async (prefix: string) => {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

test('discovers repo files while ignoring scanner-owned directories', async () => {
  const root = await repo('agentloop-scan-discovery-');
  await Promise.all([
    mkdir(join(root, 'src'), { recursive: true }),
    mkdir(join(root, '.git'), { recursive: true }),
    mkdir(join(root, '.agentloop'), { recursive: true }),
    mkdir(join(root, '.context'), { recursive: true }),
    mkdir(join(root, 'dist'), { recursive: true }),
    mkdir(join(root, 'node_modules', 'pkg'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, 'README.md'), '# Docs\n', 'utf-8'),
    writeFile(join(root, 'src', 'app.ts'), 'export const app = 1;\n', 'utf-8'),
    writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8'),
    writeFile(join(root, '.agentloop', 'inventory.json'), '{}', 'utf-8'),
    writeFile(join(root, '.context', 'note.md'), 'note\n', 'utf-8'),
    writeFile(join(root, 'dist', 'bundle.js'), 'bundle\n', 'utf-8'),
    writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};\n', 'utf-8'),
  ]);

  const files = await discoverRepoFiles(root), paths = files.map(file => file.path).sort();

  expect(paths).toEqual(['README.md', 'src/app.ts']);
  expect(files.find(file => file.path === 'README.md')?.modifiedAt).toBeDefined();
  expect(files.find(file => file.path === 'src/app.ts')?.modifiedAt).toBeUndefined();
});

test('resolves only relative repo imports to matching source files', async () => {
  const root = await repo('agentloop-scan-resolve-');
  await mkdir(join(root, 'src', 'lib'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'src', 'entry.ts'), 'export const entry = 1;', 'utf-8'),
    writeFile(join(root, 'src', 'lib', 'util.ts'), 'export const util = 1;', 'utf-8'),
    writeFile(join(root, 'src', 'lib', 'view.jsx'), 'export const view = 1;', 'utf-8'),
  ]);

  expect(await resolveRepoImport(root, 'src/entry.ts', './lib/util')).toBe('src/lib/util.ts');
  expect(await resolveRepoImport(root, 'src/entry.ts', './lib/view')).toBe('src/lib/view.jsx');
  expect(await resolveRepoImport(root, 'src/entry.ts', 'react')).toBeUndefined();
});
