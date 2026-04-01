import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const IGNORE = new Set(['.git', '.agentloop', '.context', 'dist', 'node_modules']);
const exists = (path: string) => stat(path).then(() => true).catch(() => false);
const text = (path: string) => readFile(path, 'utf-8').catch(() => '');

export interface DiscoveredRepoFile {
  path: string;
  body: string;
  lines: number;
  modifiedAt?: string;
}

async function walk(root: string, dir = ''): Promise<string[]> {
  const entries = await readdir(join(root, dir), { withFileTypes: true });
  const nested = await Promise.all(entries.flatMap(entry => {
    const next = join(dir, entry.name);
    return entry.isDirectory() ? (IGNORE.has(entry.name) ? [] : [walk(root, next)]) : [Promise.resolve([next])];
  }));
  return nested.flat();
}

export async function discoverRepoFiles(repoPath: string): Promise<DiscoveredRepoFile[]> {
  const paths = await walk(repoPath), files: DiscoveredRepoFile[] = [];
  for (const path of paths) {
    const full = join(repoPath, path), body = await text(full);
    files.push({ path, body, lines: body ? body.split('\n').length : 0, modifiedAt: path.endsWith('.md') ? (await stat(full)).mtime.toISOString() : undefined });
  }
  return files;
}

export async function resolveRepoImport(repoPath: string, file: string, specifier: string): Promise<string | undefined> {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(join(repoPath, file)), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, join(base, 'index.ts'), join(base, 'index.tsx'), join(base, 'index.js')];
  for (const candidate of candidates) if (await exists(candidate)) return relative(repoPath, candidate).replaceAll('\\', '/');
  return undefined;
}
