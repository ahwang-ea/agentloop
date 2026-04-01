import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { err, ok, type Result } from '../shared/result.js';
import type { InventoryDependencyFile, InventoryDoc, InventoryFile, InventoryPackage, RepoInventory } from '../types/index.js';

const IGNORE = new Set(['.git', '.agentloop', '.context', 'dist', 'node_modules']);
const TEST = /(\.test|\.spec)\.[cm]?[jt]sx?$|_test\.py$/;
const CI = [/^\.github\/workflows\//, /^\.gitlab-ci\.yml$/, /^\.circleci\/config\.ya?ml$/, /^azure-pipelines\.ya?ml$/];
const IMPORT = /from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)/g;
const ENV = /process\.env\.([A-Z][A-Z0-9_]+)|import\.meta\.env\.([A-Z][A-Z0-9_]+)|os\.getenv\(['"]([A-Z][A-Z0-9_]+)['"]\)/g;
const MAX_FILE_LINES = 150;
const exists = (path: string) => stat(path).then(() => true).catch(() => false);
const text = (path: string) => readFile(path, 'utf-8').catch(() => '');
const packageOf = (packages: InventoryPackage[], file: string) => packages.filter(pkg => file === pkg.path || file.startsWith(`${pkg.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
const envExample = (body: string) => body.split('\n').map(line => line.trim()).filter(line => /^[A-Z][A-Z0-9_]+=/.test(line)).map(line => line.split('=')[0]);
const importsOf = (body: string) => [...body.matchAll(IMPORT)].map(match => match[1] ?? match[2]).filter(Boolean) as string[];
const envOf = (body: string) => [...body.matchAll(ENV)].map(match => match.slice(1).find(Boolean)).filter(Boolean) as string[];

async function walk(root: string, dir = ''): Promise<string[]> {
  const entries = await readdir(join(root, dir), { withFileTypes: true });
  const nested = await Promise.all(entries.flatMap(entry => {
    const next = join(dir, entry.name);
    return entry.isDirectory() ? (IGNORE.has(entry.name) ? [] : [walk(root, next)]) : [Promise.resolve([next])];
  }));
  return nested.flat();
}

async function resolveImport(root: string, file: string, specifier: string): Promise<string | undefined> {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(join(root, file)), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, join(base, 'index.ts'), join(base, 'index.tsx'), join(base, 'index.js')];
  for (const candidate of candidates) if (await exists(candidate)) return relative(root, candidate).replaceAll('\\', '/');
  return undefined;
}

function packageJson(path: string, body: string): { package?: InventoryPackage; dependencies?: InventoryDependencyFile; frameworks: string[]; workspaces: boolean } {
  try {
    const json = JSON.parse(body) as { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; workspaces?: string[] | { packages?: string[] } };
    const deps = Object.keys({ ...(json.dependencies ?? {}), ...(json.devDependencies ?? {}) });
    const frameworks = ['jest', 'vitest', 'mocha'].filter(name => deps.includes(name));
    return {
      package: { name: json.name ?? path, path: dirname(path) === '.' ? '.' : dirname(path) },
      dependencies: { path, kind: 'package.json', dependencies: deps },
      frameworks,
      workspaces: Array.isArray(json.workspaces) || Array.isArray(json.workspaces?.packages),
    };
  } catch { return { frameworks: [], workspaces: false }; }
}

function pyproject(path: string, body: string): InventoryDependencyFile {
  const poetry = body.split('\n').filter(line => /^[A-Za-z0-9_-]+\s*=/.test(line)).map(line => line.split('=')[0].trim()).filter(name => name !== 'python');
  const pep = [...body.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]).filter(dep => /^[A-Za-z0-9_.-]+/.test(dep));
  return { path, kind: 'pyproject.toml', dependencies: [...new Set([...poetry, ...pep])] };
}

export async function scanRepo(repoPath: string): Promise<Result<RepoInventory>> {
  try {
    const paths = await walk(repoPath), bodies = new Map<string, string>(), files: InventoryFile[] = [], docs: InventoryDoc[] = [], dependencies: InventoryDependencyFile[] = [], packages: InventoryPackage[] = [], frameworks = new Set<string>(), envRef = new Set<string>(), importCounts = new Map<string, number>(), cross = new Set<string>();
    let resultCount = 0, tryCatchCount = 0, serviceFileCount = 0, controllerFileCount = 0, workspaces = false;
    for (const path of paths) {
      const full = join(repoPath, path), body = await text(full); bodies.set(path, body); files.push({ path, lines: body ? body.split('\n').length : 0 });
      if (path.endsWith('.md')) docs.push({ path, modifiedAt: (await stat(full)).mtime.toISOString() });
      if (path.endsWith('package.json')) { const parsed = packageJson(path, body); if (parsed.package) packages.push(parsed.package); if (parsed.dependencies) dependencies.push(parsed.dependencies); parsed.frameworks.forEach(name => frameworks.add(name)); workspaces ||= parsed.workspaces; }
      if (path.endsWith('pyproject.toml')) { dependencies.push(pyproject(path, body)); if (/pytest/.test(body)) frameworks.add('pytest'); }
      resultCount += (body.match(/Result</g) ?? []).length; tryCatchCount += (body.match(/try\s*\{|catch\s*\(/g) ?? []).length;
      if (path.includes('.service.')) serviceFileCount += 1; if (path.includes('.controller.')) controllerFileCount += 1;
      envOf(body).forEach(name => envRef.add(name));
    }
    for (const [path, body] of bodies) {
      const sourcePackage = packageOf(packages, path);
      for (const specifier of importsOf(body)) {
        const target = await resolveImport(repoPath, path, specifier);
        if (target) importCounts.set(target, (importCounts.get(target) ?? 0) + 1);
        const targetPackage = target ? packageOf(packages, target) : packages.find(pkg => pkg.name === specifier);
        if (sourcePackage && targetPackage && sourcePackage.name !== targetPackage.name) cross.add(`${sourcePackage.name} -> ${targetPackage.name}`);
      }
    }
    const example = envExample([bodies.get('.env.example') ?? '', bodies.get('.env.sample') ?? ''].join('\n'));
    return ok({
      scannedAt: new Date().toISOString(),
      files,
      monorepo: workspaces || packages.length > 1,
      packages: packages.sort((a, b) => a.path.localeCompare(b.path)),
      crossPackageImports: [...cross].sort(),
      patterns: { resultCount, tryCatchCount, serviceFileCount, controllerFileCount },
      tests: { frameworks: [...frameworks].sort(), count: files.filter(file => TEST.test(file.path)).length },
      docs: docs.sort((a, b) => a.path.localeCompare(b.path)),
      dependencies,
      env: {
        example: [...new Set(example)].sort(),
        referenced: [...envRef].sort(),
        missingInExample: [...envRef].filter(name => !example.includes(name)).sort(),
        unusedInExample: [...new Set(example)].filter(name => !envRef.has(name)).sort(),
      },
      oversizedFiles: files.filter(file => file.lines > MAX_FILE_LINES).map(file => file.path).sort(),
      ci: paths.filter(path => CI.some(pattern => pattern.test(path))).sort(),
      importFrequency: [...importCounts].map(([path, importedBy]) => ({ path, importedBy })).sort((a, b) => b.importedBy - a.importedBy || a.path.localeCompare(b.path)),
    });
  } catch (e) { return err('TRANSPORT_ERROR', `Scanner failed: ${e instanceof Error ? e.message : 'unknown error'}`); }
}

export async function writeInventory(repoPath: string): Promise<Result<RepoInventory>> {
  const inventory = await scanRepo(repoPath);
  if (!inventory.ok) return inventory;
  try {
    await mkdir(join(repoPath, '.agentloop'), { recursive: true });
    await writeFile(join(repoPath, '.agentloop', 'inventory.json'), JSON.stringify(inventory.value, null, 2), 'utf-8');
    return inventory;
  } catch (e) { return err('TRANSPORT_ERROR', `Cannot write inventory.json: ${e instanceof Error ? e.message : 'unknown error'}`); }
}

export async function readInventory(repoPath: string): Promise<Result<RepoInventory | undefined>> {
  try { return ok(JSON.parse(await readFile(join(repoPath, '.agentloop', 'inventory.json'), 'utf-8')) as RepoInventory); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ok(undefined);
    return err('TRANSPORT_ERROR', `Cannot read inventory.json: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
}
