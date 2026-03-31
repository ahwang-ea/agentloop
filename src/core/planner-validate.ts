import type { TaskInput } from '../types/index.js';
import { isTypesTask } from './feature.js';
import type { PlannedTask } from './planner-types.js';

const taskTypes = new Set(['research', 'implement', 'integrate', 'debug']);
const priorities = new Set(['low', 'medium', 'high']);
const pathPattern = /(?:^|[\s('"`])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)(?=$|[\s)'"`,:;])/g;
const namedFiles = new Set(['README.md', 'package.json', 'tsconfig.json', 'verify.sh']);
const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
const matches = (path: string, patterns: string[]) => patterns.some(pattern => glob(pattern).test(path));
const acceptanceFiles = (items: string[]) => [...new Set(items.flatMap(item => [...item.matchAll(pathPattern)].map(([, path]) => path)).filter(path => path.includes('/') || namedFiles.has(path)))];

export function validateTaskInput(task: Pick<TaskInput, 'type' | 'scope' | 'acceptanceCriteria' | 'priority'>): string[] {
  const issues: string[] = [];
  if (task.type && !taskTypes.has(task.type)) issues.push(`Invalid task type: ${task.type}`);
  if (task.priority && !priorities.has(task.priority)) issues.push(`Invalid priority: ${task.priority}`);
  if (!Array.isArray(task.scope.editableFiles) || task.scope.editableFiles.length === 0) issues.push('editableFiles must be non-empty');
  if (['implement', 'integrate'].includes(task.type ?? '') && task.acceptanceCriteria.length === 0) issues.push(`${task.type} tasks require acceptance criteria`);
  return issues;
}

export function validatePlan(plan: PlannedTask[]): string[] {
  const issues: string[] = [], ids = new Set<string>();
  const positions = new Map(plan.map((task, index) => [task.planId, index]));
  for (const task of plan) {
    if (!task.planId.trim()) issues.push('Every task requires a unique planId');
    if (ids.has(task.planId)) issues.push(`Duplicate planId: ${task.planId}`); else ids.add(task.planId);
    for (const issue of validateTaskInput(task)) issues.push(`[${task.planId}] ${issue}`);
    for (const file of acceptanceFiles(task.acceptanceCriteria)) {
      const covered = matches(file, task.scope.editableFiles) || matches(file, task.scope.readOnlyContext) || matches(file, task.scope.forbiddenFiles);
      if (!covered) issues.push(`[${task.planId}] acceptance criteria references ${file} outside scope`);
    }
  }
  for (const task of plan) for (const depId of task.dependsOn ?? []) {
    const pos = positions.get(depId);
    if (pos == null) issues.push(`[${task.planId}] dependsOn references missing ${depId}`);
    else if (pos >= (positions.get(task.planId) ?? -1)) issues.push(`[${task.planId}] dependsOn must reference earlier task ${depId}`);
  }
  for (const [feature, tasks] of [...new Map(plan.filter(task => task.feature).map(task => [task.feature!, plan.filter(item => item.feature === task.feature)])).entries()]) {
    let seenNonTypes = false;
    for (const task of tasks) {
      const isTypes = isTypesTask({ ...task, id: task.planId, createdAt: '' });
      if (!isTypes) seenNonTypes = true;
      if (isTypes && seenNonTypes) issues.push(`[${feature}] types-first ordering violated by ${task.planId}`);
    }
  }
  const visiting = new Set<string>(), visited = new Set<string>(), graph = new Map(plan.map(task => [task.planId, task.dependsOn ?? []]));
  const dfs = (id: string) => {
    if (visited.has(id) || visiting.has(id)) return visiting.has(id);
    visiting.add(id);
    const cycle = (graph.get(id) ?? []).some(dfs);
    visiting.delete(id); visited.add(id);
    return cycle;
  };
  for (const task of plan) if (dfs(task.planId)) issues.push(`Circular dependency detected at ${task.planId}`);
  return [...new Set(issues)];
}
