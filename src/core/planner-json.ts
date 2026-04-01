import { err, ok, type Result } from '../shared/result.js';
import { extractJson } from './review-output.js';
import type { PlannedTask } from './planner-types.js';

const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()) : [];
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const scope = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const uniq = (items: string[]) => [...new Set(items.filter(Boolean))].sort();
const pathPattern = /(?:^|[\s('"`])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)(?=$|[\s)'"`,:;])/g;
const namedFiles = new Set(['README.md', 'package.json', 'tsconfig.json', 'verify.sh']);
const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
const matches = (path: string, patterns: string[]) => patterns.some(pattern => glob(pattern).test(path));
const acceptanceFiles = (items: string[]) => uniq(items.flatMap(item => [...item.matchAll(pathPattern)].map(([, path]) => path)).filter(path => path.includes('/') || namedFiles.has(path)));
const taskType = (value: unknown): PlannedTask['type'] => {
  const normalized = text(value).toLowerCase();
  return normalized === 'test' ? 'implement' : normalized as PlannedTask['type'];
};
const normalizeTask = (task: PlannedTask): PlannedTask => {
  const extras = acceptanceFiles(task.acceptanceCriteria).filter(file => !matches(file, task.scope.editableFiles) && !matches(file, task.scope.readOnlyContext) && !matches(file, task.scope.forbiddenFiles));
  return extras.length === 0 ? task : { ...task, scope: { ...task.scope, editableFiles: uniq([...task.scope.editableFiles, ...extras]) } };
};
const taskRecord = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const plannedTask = (value: unknown): PlannedTask => {
  const item = taskRecord(value), itemScope = scope(item.scope);
  return normalizeTask({
    planId: text(item.planId),
    title: text(item.title),
    description: text(item.description),
    feature: text(item.feature) || undefined,
    type: taskType(item.type),
    priority: text(item.priority) as PlannedTask['priority'],
    scope: {
      editableFiles: list(itemScope.editableFiles),
      readOnlyContext: list(itemScope.readOnlyContext),
      forbiddenFiles: list(itemScope.forbiddenFiles),
    },
    acceptanceCriteria: list(item.acceptanceCriteria),
    dependsOn: list(item.dependsOn),
  });
};

export const parsePlanJson = (raw: string): Result<PlannedTask[]> => {
  const json = extractJson(raw); if (!json) return err('SESSION_ERROR', 'Planner returned no JSON');
  let parsed: unknown; try { parsed = JSON.parse(json); } catch { return err('SESSION_ERROR', 'Planner returned invalid JSON'); }
  return Array.isArray(parsed) ? ok(parsed.map(plannedTask)) : err('SESSION_ERROR', 'Planner output must be a JSON array');
};
