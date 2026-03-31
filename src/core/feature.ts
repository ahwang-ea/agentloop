import type { TaskDefinition, TaskState } from '../types/index.js';

const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const typeFile = (path: string) => /(^|\/)(types\/|.*\.d\.ts$|.*\.types?\.[cm]?[jt]sx?$)/.test(path);
const unfinishedTypes = <T extends Pick<TaskState, 'status' | 'task'>>(tasks: T[], feature: string) =>
  tasks.some(task => task.task.feature === feature && task.status !== 'done' && isTypesTask(task.task));

export const featureBranchName = (feature: string) => `feature-${slugify(feature)}`;
export const isTypesTask = (task: TaskDefinition) => task.scope.editableFiles.some(typeFile)
  || /\btype(s| definition)?\b/i.test(`${task.title} ${task.description}`);
export const canFeatureTaskRun = <T extends Pick<TaskState, 'status' | 'task'>>(tasks: T[], task: TaskDefinition) =>
  !task.feature || isTypesTask(task) || !unfinishedTypes(tasks, task.feature);

export function pickQueuedTask<T extends Pick<TaskState, 'status' | 'task'>>(tasks: T[]): T | undefined {
  for (const task of tasks.filter(item => item.status === 'queued')) if (canFeatureTaskRun(tasks, task.task)) return task;
  return undefined;
}

export const remainingFeatureTasks = (tasks: TaskState[], feature: string, currentTaskId: string) =>
  tasks.filter(task => task.task.feature === feature && task.task.id !== currentTaskId && task.status !== 'done');
