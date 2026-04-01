import type { RepoInventory } from '../types/index.js';

export interface InventoryDelta {
  newModules: string[];
  newDependencies: string[];
  newEnvVars: string[];
  constraintChanges: string[];
  grownFiles: Array<{ path: string; before: number; after: number }>;
}

const PYPROJECT_REQUIREMENT = /^\s*([A-Za-z][A-Za-z0-9_.-]*)(?:\[[^\]]+\])?/;
const normalizedDependency = (kind: RepoInventory['dependencies'][number]['kind'], dependency: string) => kind === 'pyproject.toml'
  ? dependency === 'dependencies' ? undefined : dependency.match(PYPROJECT_REQUIREMENT)?.[1]
  : dependency;
const depsOf = (inventory: RepoInventory) => [...new Set(inventory.dependencies.flatMap(file => file.dependencies.map(dependency => normalizedDependency(file.kind, dependency)).filter(Boolean) as string[]))].sort();
const linesOf = (inventory: RepoInventory) => new Map(inventory.files.map(file => [file.path, file.lines]));
const frameworksOf = (inventory: RepoInventory) => [...new Set(inventory.tests.frameworks)].sort();

export function diffInventories(before: RepoInventory, after: RepoInventory): InventoryDelta {
  const beforeDeps = new Set(depsOf(before)), beforeEnv = new Set(before.env.referenced), beforeModules = new Set(before.packages.map(pkg => pkg.path));
  const beforeCross = new Set(before.crossPackageImports), beforeCi = new Set(before.ci), beforeFrameworks = new Set(frameworksOf(before)), lines = linesOf(before);
  const constraintChanges = [
    ...(before.monorepo === after.monorepo ? [] : [`Monorepo mode ${after.monorepo ? 'enabled' : 'disabled'}`]),
    ...after.crossPackageImports.filter(item => !beforeCross.has(item)).map(item => `New cross-package dependency: ${item}`),
    ...after.ci.filter(path => !beforeCi.has(path)).map(path => `New CI config: ${path}`),
    ...frameworksOf(after).filter(name => !beforeFrameworks.has(name)).map(name => `New test framework: ${name}`),
  ];
  return {
    newModules: after.packages.map(pkg => pkg.path).filter(path => !beforeModules.has(path)),
    newDependencies: depsOf(after).filter(dep => !beforeDeps.has(dep)),
    newEnvVars: after.env.referenced.filter(name => !beforeEnv.has(name)),
    constraintChanges,
    grownFiles: after.files
      .map(file => ({ path: file.path, before: lines.get(file.path) ?? 0, after: file.lines }))
      .filter(file => file.after > file.before)
      .sort((a, b) => (b.after - b.before) - (a.after - a.before))
      .slice(0, 3),
  };
}

export const needsArchitectureUpdate = (delta: InventoryDelta) =>
  delta.newModules.length > 0 || delta.newDependencies.length > 0 || delta.newEnvVars.length > 0 || delta.constraintChanges.length > 0;

export const formatIntentSummary = (delta: InventoryDelta) => [
  `Since last check: ${delta.newModules.length} new modules, ${delta.grownFiles[0] ? `${delta.grownFiles[0].path} grew to ${delta.grownFiles[0].after} lines` : 'no notable file growth'}, ${delta.newEnvVars.length} new env vars.`,
  delta.constraintChanges.length === 0 ? '' : `Constraint changes: ${delta.constraintChanges.join('; ')}.`,
  'Still aligned with your goals? Reply to adjust.',
].filter(Boolean).join(' ');
