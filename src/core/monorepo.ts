import { err, ok, type Result } from '../shared/result.js';
import type { RepoInventory, TaskDefinition } from '../types/index.js';
import { readInventory, scanRepo } from './scanner.js';

export type TaskSeed = Omit<TaskDefinition, 'id' | 'createdAt'>;
const uniq = <T>(items: T[]) => [...new Set(items)];
const members = (inventory: RepoInventory) => inventory.monorepo ? inventory.packages.filter(pkg => pkg.path !== '.') : [];
const shared = (inventory: RepoInventory) => members(inventory)
  .filter(pkg => /(^|\/)(common|shared)(\/|$)/i.test(pkg.path) || /\b(common|shared)\b/i.test(pkg.name));
const broad = (pattern: string) => ['*', '**', '**/*', '.'].includes(pattern.trim());
const touches = (pattern: string, pkgPath: string) => broad(pattern) || pattern === pkgPath || pattern.startsWith(`${pkgPath}/`);

export const monorepoPackages = (inventory: RepoInventory) => members(inventory).map(pkg => pkg.path);
export const packageScope = (pkgPath: string) => [`${pkgPath}/**/*`];
export const scopedPackages = (patterns: string[], inventory: RepoInventory) => uniq(members(inventory)
  .filter(pkg => patterns.some(pattern => touches(pattern, pkg.path))).map(pkg => pkg.path));

export function applyMonorepoTaskRules(task: TaskSeed, inventory: RepoInventory): Result<TaskSeed> {
  if (!inventory.monorepo) return ok(task);
  const touched = scopedPackages(task.scope.editableFiles, inventory), sharedPaths = shared(inventory).map(pkg => pkg.path);
  if (touched.length > 1) return err('CONFIG_ERROR', `Monorepo task must target one package. Split into sequential tasks: ${touched.join(', ')}`);
  if (task.feature && touched.some(path => sharedPaths.includes(path))) {
    return err('CONFIG_ERROR', `Feature tasks cannot edit common/shared packages directly: ${touched.filter(path => sharedPaths.includes(path)).join(', ')}`);
  }
  if (!task.feature || touched.length === 0 || sharedPaths.length === 0) return ok(task);
  return ok({
    ...task,
    scope: {
      ...task.scope,
      readOnlyContext: uniq([...task.scope.readOnlyContext, ...sharedPaths.filter(path => !touched.includes(path)).map(path => `${path}/MODULE.md`)]),
      forbiddenFiles: uniq([...task.scope.forbiddenFiles, ...sharedPaths.filter(path => !touched.includes(path)).map(path => `${path}/**/*`)]),
    },
  });
}

export async function normalizeTaskForRepo(repoPath: string, task: TaskSeed): Promise<Result<TaskSeed>> {
  const inventory = await readInventory(repoPath); if (!inventory.ok) return inventory;
  const loaded = inventory.value ? ok(inventory.value) : await scanRepo(repoPath);
  return loaded.ok ? applyMonorepoTaskRules(task, loaded.value) : loaded;
}
