import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatMetricsSummary, readMetricsSummary } from '../metrics-report.js';
import { logMetrics, metricsFromTaskState, recordReviewFindings, recordSessionChanges, recordVerifyErrors } from '../metrics.js';
import type { ConvergenceState, ReviewFinding, TaskState } from '../../types/index.js';

const repoPath = () => mkdtemp(join(tmpdir(), 'agentloop-metrics-'));
const task = (id: string, title: string) => ({
  id,
  title,
  description: '',
  scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] },
  acceptanceCriteria: [],
  model: 'auto' as const,
  priority: 'medium' as const,
  createdAt: '2026-03-20T12:00:00.000Z',
});

test('collects task metric stats from convergence state', () => {
  const conv: ConvergenceState = {
    rounds: [{ round: 1, issueCount: 1, issueHashes: ['a'], elapsed: 2, tokens: 100 }],
    classification: 'unknown',
    webSearchTriggered: false,
    reviewFindings: 0,
    errorTypes: [],
    changedFiles: [],
  };
  recordSessionChanges(conv, ['src/api.ts']);
  recordVerifyErrors(conv, [{ source: 'typecheck', message: 'Missing validation for cancel', hash: 'abc' }]);
  recordReviewFindings(conv, [{ reviewer: 'codex-detail', severity: 'issue', topicKey: 'missing validation', action: 'change', description: 'Add missing validation' } as ReviewFinding]);
  const stats = metricsFromTaskState({ task: task('task-1', 'Add cancel endpoint'), status: 'done', round: 1, startedAt: '2026-03-29T12:00:00.000Z', completedAt: '2026-03-29T12:04:00.000Z', convergence: conv } as TaskState);
  expect(stats).toEqual({ rounds: 1, timeSec: 240, reviewFindings: 1, errors: ['missing_validation', 'missing_validation_for_cancel'], files: ['src/api.ts'], timestamp: '2026-03-29T12:04:00.000Z' });
});

test('summarizes latest task outcome per task id', async () => {
  const repo = await repoPath();
  await logMetrics({ repoPath: repo }, task('same', 'Checkout flow'), 'blocked', { rounds: 3, timeSec: 300, reviewFindings: 2, errors: ['review_conflict'], files: ['src/checkout.ts'], timestamp: '2026-03-18T12:00:00.000Z' });
  await logMetrics({ repoPath: repo }, task('same', 'Checkout flow'), 'merged', { rounds: 1, timeSec: 120, reviewFindings: 0, errors: [], files: ['src/checkout.ts'], timestamp: new Date().toISOString() });
  await logMetrics({ repoPath: repo }, task('other', 'Refund flow'), 'stuck', { rounds: 4, timeSec: 240, reviewFindings: 1, errors: ['missing_validation'], files: ['src/refund.ts'], timestamp: new Date().toISOString() });
  const summary = await readMetricsSummary({ repoPath: repo });
  expect(summary.ok).toBe(true);
  if (!summary.ok) return;
  expect(summary.value.last7.tasks).toBe(2);
  expect(summary.value.last7.avgRounds).toBe(2.5);
  expect(summary.value.last7.firstPassRate).toBe(50);
  expect(summary.value.last7.stuckRate).toBe(50);
  expect(summary.value.last7.topError).toBe('missing_validation');
  expect(formatMetricsSummary(summary.value)).toContain('Last 7 days: 2 tasks');
});
