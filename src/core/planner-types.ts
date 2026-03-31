import type { TaskPriority, TaskScope, TaskType } from '../types/index.js';

export interface PlannedTask {
  planId: string;
  title: string;
  description: string;
  type: TaskType;
  scope: TaskScope;
  acceptanceCriteria: string[];
  priority: TaskPriority;
  feature?: string;
  dependsOn?: string[];
}
