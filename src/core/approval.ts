import { ok, type Result } from '../shared/result.js';
import type { AgentloopConfig } from '../types/index.js';
import { createFileTaskQueue } from './task-queue.js';

export async function approveFeatureGate(config: AgentloopConfig, taskId: string): Promise<Result<void>> {
  const approved = await createFileTaskQueue(config).approveBlocked(taskId);
  if (!approved.ok) return approved;
  console.log(`Approved blocked feature gate for ${taskId}`);
  return ok(undefined);
}
