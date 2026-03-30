import { err, ok, type Result } from '../shared/result.js';
import type { RepoInventory, TaskInput } from '../types/index.js';
import { readInventory, scanRepo } from './scanner.js';

export type TaskSeed = TaskInput;
const uniq = <T>(items: T[]) => [...new Set(items)];
const members = (inventory: RepoInventory) => inventory.monorepo ? inventory.packages.filter(pkg => pkg.path !== '.') : [];
const shared = (inventory: RepoInventory) => members(inventory)
  .filter(pkg => /(^|\/)(common|shared)(\/|$)/i.test(pkg.path) || /\b(common|shared)\b/i.test(pkg.name));
const broad = (pattern: string) => ['*', '**', '**/*', '.'].includes(pattern.trim());
const touches = (pattern: string, pkgPath: string) => broad(pattern) || pattern === pkgPath || pattern.startsWith(`${pkgPath}/`);
const typed = (task: TaskSeed): TaskSeed => ({ ...task, type: task.type ?? 'implement' });

export const monorepoPackages = (inventory: RepoInventory) => members(inventory).map(pkg => pkg.path);
export const packageScope = (pkgPath: string) => [`${pkgPath}/**/*`];
export const scopedPackages = (patterns: string[], inventory: RepoInventory) => uniq(members(inventory)
  .filter(pkg => patterns.some(pattern => touches(pattern, pkg.path))).map(pkg => pkg.path));

export function applyMonorepoTaskRules(task: TaskSeed, inventory: RepoInventory): Result<TaskSeed> {
  const next = typed(task);
  if (!inventory.monorepo) return ok(next);
  const touched = scopedPackages(next.scope.editableFiles, inventory), sharedPaths = shared(inventory).map(pkg => pkg.path);
  if (touched.length > 1) return err('CONFIG_ERROR', `Monorepo task must target one package. Split into sequential tasks: ${touched.join(', ')}`);
  if (next.feature && touched.some(path => sharedPaths.includes(path))) {
    return err('CONFIG_ERROR', `Feature tasks cannot edit common/shared packages directly: ${touched.filter(path => sharedPaths.includes(path)).join(', ')}`);
  }
  if (!next.feature || touched.length === 0 || sharedPaths.length === 0) return ok(next);
  return ok({
    ...next,
    scope: {
      ...next.scope,
      readOnlyContext: uniq([...next.scope.readOnlyContext, ...sharedPaths.filter(path => !touched.includes(path)).map(path => `${path}/MODULE.md`)]),
      forbiddenFiles: uniq([...next.scope.forbiddenFiles, ...sharedPaths.filter(path => !touched.includes(path)).map(path => `${path}/**/*`)]),
    },
  });
}

export async function normalizeTaskForRepo(repoPath: string, task: TaskSeed): Promise<Result<TaskSeed>> {
  const inventory = await readInventory(repoPath); if (!inventory.ok) return inventory;
  const loaded = inventory.value ? ok(inventory.value) : await scanRepo(repoPath);
  return loaded.ok ? applyMonorepoTaskRules(task, loaded.value) : loaded;
}
