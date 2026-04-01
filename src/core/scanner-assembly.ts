import type { InventoryDependencyFile, InventoryDoc, InventoryFile, InventoryPackage, RepoInventory } from '../types/index.js';
import type { DiscoveredRepoFile } from './scanner-discovery.js';
import type { ParsedPackageJson } from './scanner-manifests.js';

const TEST = /(\.test|\.spec)\.[cm]?[jt]sx?$|_test\.py$/;
const CI = [/^\.github\/workflows\//, /^\.gitlab-ci\.yml$/, /^\.circleci\/config\.ya?ml$/, /^azure-pipelines\.ya?ml$/];
const IMPORT = /from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)/g;
const ENV = /process\.env\.([A-Z][A-Z0-9_]+)|import\.meta\.env\.([A-Z][A-Z0-9_]+)|os\.getenv\(['"]([A-Z][A-Z0-9_]+)['"]\)/g;
const MAX_FILE_LINES = 150;

export interface InventoryBuildState {
  bodies: Map<string, string>;
  files: InventoryFile[];
  docs: InventoryDoc[];
  dependencies: InventoryDependencyFile[];
  packages: InventoryPackage[];
  frameworks: Set<string>;
  envReferences: Set<string>;
  importCounts: Map<string, number>;
  crossPackageImports: Set<string>;
  patterns: RepoInventory['patterns'];
  workspaces: boolean;
}

const packageOf = (packages: InventoryPackage[], file: string) => packages.filter(pkg => file === pkg.path || file.startsWith(`${pkg.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
const envExampleOf = (body: string) => body.split('\n').map(line => line.trim()).filter(line => /^[A-Z][A-Z0-9_]+=/.test(line)).map(line => line.split('=')[0]);
const envOf = (body: string) => [...body.matchAll(ENV)].map(match => match.slice(1).find(Boolean)).filter(Boolean) as string[];

export const importsOfBody = (body: string) => [...body.matchAll(IMPORT)].map(match => match[1] ?? match[2]).filter(Boolean) as string[];

export const createInventoryBuildState = (): InventoryBuildState => ({
  bodies: new Map(),
  files: [],
  docs: [],
  dependencies: [],
  packages: [],
  frameworks: new Set(),
  envReferences: new Set(),
  importCounts: new Map(),
  crossPackageImports: new Set(),
  patterns: { resultCount: 0, tryCatchCount: 0, serviceFileCount: 0, controllerFileCount: 0 },
  workspaces: false,
});

export function recordInventoryFile(state: InventoryBuildState, file: DiscoveredRepoFile): void {
  state.bodies.set(file.path, file.body);
  state.files.push({ path: file.path, lines: file.lines });
  if (file.modifiedAt) state.docs.push({ path: file.path, modifiedAt: file.modifiedAt });
  state.patterns.resultCount += (file.body.match(/Result</g) ?? []).length;
  state.patterns.tryCatchCount += (file.body.match(/try\s*\{|catch\s*\(/g) ?? []).length;
  if (file.path.includes('.service.')) state.patterns.serviceFileCount += 1;
  if (file.path.includes('.controller.')) state.patterns.controllerFileCount += 1;
  envOf(file.body).forEach(name => state.envReferences.add(name));
}

export function addPackageJson(state: InventoryBuildState, parsed: ParsedPackageJson): void {
  if (parsed.package) state.packages.push(parsed.package);
  if (parsed.dependencies) state.dependencies.push(parsed.dependencies);
  parsed.frameworks.forEach(name => state.frameworks.add(name));
  state.workspaces ||= parsed.workspaces;
}

export function addPyproject(state: InventoryBuildState, dependency: InventoryDependencyFile, body: string): void {
  state.dependencies.push(dependency);
  if (/pytest/.test(body)) state.frameworks.add('pytest');
}

export function recordImportResolution(
  state: InventoryBuildState,
  sourcePath: string,
  specifier: string,
  targetPath?: string,
): void {
  const sourcePackage = packageOf(state.packages, sourcePath);
  if (targetPath) state.importCounts.set(targetPath, (state.importCounts.get(targetPath) ?? 0) + 1);
  const targetPackage = targetPath ? packageOf(state.packages, targetPath) : state.packages.find(pkg => pkg.name === specifier);
  if (sourcePackage && targetPackage && sourcePackage.name !== targetPackage.name) state.crossPackageImports.add(`${sourcePackage.name} -> ${targetPackage.name}`);
}

export function toRepoInventory(state: InventoryBuildState, discoveredFiles: DiscoveredRepoFile[]): RepoInventory {
  const example = envExampleOf([state.bodies.get('.env.example') ?? '', state.bodies.get('.env.sample') ?? ''].join('\n'));
  return {
    version: 1,
    scannedAt: new Date().toISOString(),
    files: state.files,
    monorepo: state.workspaces || state.packages.length > 1,
    packages: state.packages.sort((a, b) => a.path.localeCompare(b.path)),
    crossPackageImports: [...state.crossPackageImports].sort(),
    patterns: state.patterns,
    tests: { frameworks: [...state.frameworks].sort(), count: state.files.filter(file => TEST.test(file.path)).length },
    docs: state.docs.sort((a, b) => a.path.localeCompare(b.path)),
    dependencies: state.dependencies,
    env: {
      example: [...new Set(example)].sort(),
      referenced: [...state.envReferences].sort(),
      missingInExample: [...state.envReferences].filter(name => !example.includes(name)).sort(),
      unusedInExample: [...new Set(example)].filter(name => !state.envReferences.has(name)).sort(),
    },
    oversizedFiles: state.files.filter(file => file.lines > MAX_FILE_LINES).map(file => file.path).sort(),
    ci: discoveredFiles.map(file => file.path).filter(path => CI.some(pattern => pattern.test(path))).sort(),
    importFrequency: [...state.importCounts].map(([path, importedBy]) => ({ path, importedBy })).sort((a, b) => b.importedBy - a.importedBy || a.path.localeCompare(b.path)),
  };
}
