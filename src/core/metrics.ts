import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from '../shared/result.js';
import type {
  AgentloopConfig, ConvergenceState, MetricsOutcome, MetricsRecord,
  ReviewFinding, TaskDefinition, TaskMetricsStats, TaskQueueAdapter, TaskState, VerifyError,
} from '../types/index.js';
import { withArtifactLock } from './artifact-lock.js';

const unique = (values: string[]) => [...new Set(values.filter(Boolean))].sort();
const terminalAt = (state: TaskState) => state.completedAt ?? state.blocked?.blockedAt ?? new Date().toISOString();
const roundTotal = (state: ConvergenceState | undefined, key: 'elapsed' | 'tokens') =>
  state?.rounds.reduce((sum, round) => sum + Math.max(0, round[key]), 0) ?? 0;
const slug = (text: string) => {
  const value = text.toLowerCase().replace(/\bts\d+\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  return value ? value.split(/\s+/).slice(0, 4).join('_') : 'unknown';
};

export const metricsPath = (config: Pick<AgentloopConfig, 'repoPath'>) => join(config.repoPath, '.agentloop', 'metrics.jsonl');

export const recordSessionChanges = (state: ConvergenceState, files: string[]) => {
  state.changedFiles = unique([...state.changedFiles, ...files]);
};
export const recordErrorType = (state: ConvergenceState, label: string) => {
  state.errorTypes = unique([...state.errorTypes, slug(label)]);
};
export const recordVerifyErrors = (state: ConvergenceState, errors: VerifyError[]) => {
  state.errorTypes = unique([...state.errorTypes, ...errors.map(error => slug(error.message) || error.source)]);
};
export const recordReviewFindings = (state: ConvergenceState, findings: ReviewFinding[]) => {
  state.reviewFindings += findings.length;
  state.errorTypes = unique([...state.errorTypes, ...findings.map(finding => slug(finding.topicKey ?? finding.description))]);
};

export const metricsFromTaskState = (state: TaskState): TaskMetricsStats => {
  const timestamp = terminalAt(state), started = Date.parse(state.startedAt), ended = Date.parse(timestamp), conv = state.convergence;
  return {
    rounds: conv?.rounds.length ?? state.round,
    timeSec: Number.isNaN(started) || Number.isNaN(ended) ? 0 : Math.max(0, Math.round((ended - started) / 1000)),
    reviewFindings: conv?.reviewFindings ?? 0,
    errors: unique(conv?.errorTypes ?? []),
    files: unique(conv?.changedFiles ?? []),
    timestamp,
    taskType: state.task.type,
    tokenTotal: roundTotal(conv, 'tokens'),
    verifyTimeSec: roundTotal(conv, 'elapsed'),
  };
};

async function readTaskState(queue: TaskQueueAdapter, taskId: string): Promise<Result<TaskState>> {
  const tasks = await queue.list();
  if (!tasks.ok) return tasks;
  const task = tasks.value.find(entry => entry.task.id === taskId);
  return task ? ok(task) : err('QUEUE_EMPTY', `Task not found for metrics: ${taskId}`);
}

export async function logMetrics(
  config: Pick<AgentloopConfig, 'repoPath'>, task: TaskDefinition, outcome: MetricsOutcome, stats: TaskMetricsStats,
): Promise<Result<void>> {
  const path = metricsPath(config);
  const record: MetricsRecord = {
    version: 2,
    task_id: task.id,
    task: task.title,
    rounds: stats.rounds,
    timeSec: stats.timeSec,
    reviewFindings: stats.reviewFindings,
    outcome,
    errors: unique(stats.errors),
    files: unique(stats.files),
    timestamp: stats.timestamp,
    taskType: stats.taskType ?? task.type,
    tokenTotal: stats.tokenTotal ?? 0,
    verifyTimeSec: stats.verifyTimeSec ?? 0,
  };
  return withArtifactLock(path, 'metrics', async () => {
    try {
      await appendFile(path, `${JSON.stringify({
        ...record,
        time_sec: record.timeSec,
        review_findings: record.reviewFindings,
        task_type: record.taskType,
        token_total: record.tokenTotal,
        verify_time_sec: record.verifyTimeSec,
        timeSec: undefined,
        reviewFindings: undefined,
        taskType: undefined,
        tokenTotal: undefined,
        verifyTimeSec: undefined,
      })}\n`, 'utf-8');
      return ok(undefined);
    } catch (e) {
      return err('TRANSPORT_ERROR', `Cannot append metrics ${path}: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  });
}

export async function logTaskMetrics(
  config: Pick<AgentloopConfig, 'repoPath'>, queue: TaskQueueAdapter, task: TaskDefinition, outcome: MetricsOutcome,
): Promise<Result<void>> {
  const state = await readTaskState(queue, task.id);
  return state.ok ? logMetrics(config, task, outcome, metricsFromTaskState(state.value)) : state;
}
export async function logInferredTaskMetrics(
  config: Pick<AgentloopConfig, 'repoPath'>, queue: TaskQueueAdapter, task: TaskDefinition,
): Promise<Result<void>> {
  const state = await readTaskState(queue, task.id);
  if (!state.ok) return state;
  if (state.value.status === 'done') return logMetrics(config, task, 'merged', metricsFromTaskState(state.value));
  if (state.value.status === 'stuck') return logMetrics(config, task, 'stuck', metricsFromTaskState(state.value));
  if (state.value.status === 'blocked') return logMetrics(config, task, task.type === 'debug' ? 'needs-human' : 'blocked', metricsFromTaskState(state.value));
  return err('CONFIG_ERROR', `Task ${task.id} is not in a terminal state for metrics`);
}
