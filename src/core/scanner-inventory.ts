import { dirname } from 'node:path';
import type { InventoryDependencyFile, InventoryDoc, InventoryFile, InventoryPackage, RepoInventory } from '../types/index.js';
import type { DiscoveredRepoFile } from './scanner-discovery.js';
import { resolveRepoImport } from './scanner-discovery.js';

const TEST = /(\.test|\.spec)\.[cm]?[jt]sx?$|_test\.py$/;
const CI = [/^\.github\/workflows\//, /^\.gitlab-ci\.yml$/, /^\.circleci\/config\.ya?ml$/, /^azure-pipelines\.ya?ml$/];
const IMPORT = /from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)/g;
const ENV = /process\.env\.([A-Z][A-Z0-9_]+)|import\.meta\.env\.([A-Z][A-Z0-9_]+)|os\.getenv\(['"]([A-Z][A-Z0-9_]+)['"]\)/g;
const MAX_FILE_LINES = 150;
const packageOf = (packages: InventoryPackage[], file: string) => packages.filter(pkg => file === pkg.path || file.startsWith(`${pkg.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
const envExample = (body: string) => body.split('\n').map(line => line.trim()).filter(line => /^[A-Z][A-Z0-9_]+=/.test(line)).map(line => line.split('=')[0]);
const importsOf = (body: string) => [...body.matchAll(IMPORT)].map(match => match[1] ?? match[2]).filter(Boolean) as string[];
const envOf = (body: string) => [...body.matchAll(ENV)].map(match => match.slice(1).find(Boolean)).filter(Boolean) as string[];

function packageJson(path: string, body: string): { package?: InventoryPackage; dependencies?: InventoryDependencyFile; frameworks: string[]; workspaces: boolean } {
  try {
    const json = JSON.parse(body) as { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; workspaces?: string[] | { packages?: string[] } };
    const deps = Object.keys({ ...(json.dependencies ?? {}), ...(json.devDependencies ?? {}) });
    return {
      package: { name: json.name ?? path, path: dirname(path) === '.' ? '.' : dirname(path) },
      dependencies: { path, kind: 'package.json', dependencies: deps },
      frameworks: ['jest', 'vitest', 'mocha'].filter(name => deps.includes(name)),
      workspaces: Array.isArray(json.workspaces) || Array.isArray(json.workspaces?.packages),
    };
  } catch { return { frameworks: [], workspaces: false }; }
}

function pyproject(path: string, body: string): InventoryDependencyFile {
  const poetry = body.split('\n').filter(line => /^[A-Za-z0-9_-]+\s*=/.test(line)).map(line => line.split('=')[0].trim()).filter(name => name !== 'python');
  const pep = [...body.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]).filter(dep => /^[A-Za-z0-9_.-]+/.test(dep));
  return { path, kind: 'pyproject.toml', dependencies: [...new Set([...poetry, ...pep])] };
}

export async function buildInventory(repoPath: string, discoveredFiles: DiscoveredRepoFile[]): Promise<RepoInventory> {
  const bodies = new Map<string, string>(), files: InventoryFile[] = [], docs: InventoryDoc[] = [], dependencies: InventoryDependencyFile[] = [], packages: InventoryPackage[] = [], frameworks = new Set<string>(), envRef = new Set<string>(), importCounts = new Map<string, number>(), cross = new Set<string>();
  let resultCount = 0, tryCatchCount = 0, serviceFileCount = 0, controllerFileCount = 0, workspaces = false;
  for (const file of discoveredFiles) {
    bodies.set(file.path, file.body); files.push({ path: file.path, lines: file.lines });
    if (file.modifiedAt) docs.push({ path: file.path, modifiedAt: file.modifiedAt });
    if (file.path.endsWith('package.json')) { const parsed = packageJson(file.path, file.body); if (parsed.package) packages.push(parsed.package); if (parsed.dependencies) dependencies.push(parsed.dependencies); parsed.frameworks.forEach(name => frameworks.add(name)); workspaces ||= parsed.workspaces; }
    if (file.path.endsWith('pyproject.toml')) { dependencies.push(pyproject(file.path, file.body)); if (/pytest/.test(file.body)) frameworks.add('pytest'); }
    resultCount += (file.body.match(/Result</g) ?? []).length; tryCatchCount += (file.body.match(/try\s*\{|catch\s*\(/g) ?? []).length;
    if (file.path.includes('.service.')) serviceFileCount += 1; if (file.path.includes('.controller.')) controllerFileCount += 1;
    envOf(file.body).forEach(name => envRef.add(name));
  }
  for (const [path, body] of bodies) {
    const sourcePackage = packageOf(packages, path);
    for (const specifier of importsOf(body)) {
      const target = await resolveRepoImport(repoPath, path, specifier);
      if (target) importCounts.set(target, (importCounts.get(target) ?? 0) + 1);
      const targetPackage = target ? packageOf(packages, target) : packages.find(pkg => pkg.name === specifier);
      if (sourcePackage && targetPackage && sourcePackage.name !== targetPackage.name) cross.add(`${sourcePackage.name} -> ${targetPackage.name}`);
    }
  }
  const example = envExample([bodies.get('.env.example') ?? '', bodies.get('.env.sample') ?? ''].join('\n'));
  return {
    version: 1,
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
    ci: discoveredFiles.map(file => file.path).filter(path => CI.some(pattern => pattern.test(path))).sort(),
    importFrequency: [...importCounts].map(([path, importedBy]) => ({ path, importedBy })).sort((a, b) => b.importedBy - a.importedBy || a.path.localeCompare(b.path)),
  };
}
