import type { TaskState } from '../types/index.js';

export interface DependencyFailure { taskId: string; reason: string; }

export function findDependencyFailures(tasks: TaskState[]): DependencyFailure[] {
  const byId = new Map(tasks.map(task => [task.task.id, task]));
  const failures: DependencyFailure[] = [];
  for (const task of tasks.filter(item => item.status === 'queued')) {
    for (const depId of task.task.dependsOn ?? []) {
      const dep = byId.get(depId);
      if (!dep) { failures.push({ taskId: task.task.id, reason: `Dependency ${depId} was not found` }); break; }
      if (dep.status === 'stuck') { failures.push({ taskId: task.task.id, reason: `Dependency ${depId} is stuck` }); break; }
    }
  }
  return failures;
}
