import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logInferredTaskMetrics, logMetrics, metricsFromTaskState, recordReviewFindings, recordSessionChanges, recordVerifyErrors } from '../metrics.js';
import type { ConvergenceState, ReviewFinding, TaskDefinition, TaskState, VerifyError } from '../../types/index.js';

const repoPath = () => mkdtemp(join(tmpdir(), 'agentloop-metrics-'));
const task = (id: string, title: string, type: TaskDefinition['type'] = 'implement'): TaskDefinition => ({
  id,
  title,
  description: '',
  scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] },
  acceptanceCriteria: [],
  type,
  priority: 'medium',
  createdAt: '2026-03-18T00:00:00.000Z',
});
const state = (): ConvergenceState => ({ rounds: [], classification: 'unknown', webSearchTriggered: false, reviewFindings: 0, errorTypes: [], changedFiles: [] });

test('records and infers task metrics', async () => {
  const repo = await repoPath();
  const conv = state();
  const verifyError: VerifyError = { source: 'test', message: 'Checkout fails on timeout', hash: 'a1' };
  const finding: ReviewFinding = { reviewer: 'opus-bigpicture', severity: 'issue', description: 'Rename helper', topicKey: 'rename_helper', action: 'rename' };
  recordSessionChanges(conv, ['src/checkout.ts', 'src/checkout.ts']);
  recordVerifyErrors(conv, [verifyError]);
  recordReviewFindings(conv, [finding]);
  conv.rounds = [{ round: 1, issueCount: 1, issueHashes: ['a'], elapsed: 1, tokens: 10 }, { round: 2, issueCount: 0, issueHashes: [], elapsed: 2, tokens: 20 }];
  const stats = metricsFromTaskState({ task: task('t1', 'Checkout flow'), status: 'done', round: 2, convergence: conv, startedAt: '2026-03-18T00:00:00.000Z', completedAt: '2026-03-18T00:05:00.000Z' } as TaskState);
  expect(stats).toEqual({ rounds: 2, timeSec: 300, reviewFindings: 1, errors: ['checkout_fails_on_timeout', 'rename_helper'], files: ['src/checkout.ts'], timestamp: '2026-03-18T00:05:00.000Z' });
  const logged = await logMetrics({ repoPath: repo }, task('t1', 'Checkout flow'), 'merged', stats);
  expect(logged.ok).toBe(true);
  const content = await readFile(join(repo, '.agentloop', 'metrics.jsonl'), 'utf-8');
  expect(content).toContain('"task_id":"t1"');
  expect(content).toContain('"outcome":"merged"');
  expect(content).toContain('"time_sec":300');
  expect(content).toContain('"review_findings":1');
});

test('uses needs-human outcome for blocked debug tasks', async () => {
  const repo = await repoPath();
  const queue = { list: async () => ({ ok: true as const, value: [{ task: task('dbg', 'Debug checkout', 'debug'), status: 'blocked', round: 0, startedAt: '', blocked: { reason: 'Need human', details: {}, blockedAt: '2026-03-18T00:05:00.000Z' } }] }) };
  const logged = await logInferredTaskMetrics({ repoPath: repo }, queue as never, task('dbg', 'Debug checkout', 'debug'));
  expect(logged.ok).toBe(true);
  expect(await readFile(join(repo, '.agentloop', 'metrics.jsonl'), 'utf-8')).toContain('"outcome":"needs-human"');
});

test('dedupes metrics summaries by latest timestamp', async () => {
  const repo = await repoPath();
  await logMetrics({ repoPath: repo }, task('same', 'Checkout flow'), 'blocked', { rounds: 3, timeSec: 300, reviewFindings: 2, errors: ['review_conflict'], files: ['src/checkout.ts'], timestamp: '2026-03-18T12:00:00.000Z' });
  await logMetrics({ repoPath: repo }, task('same', 'Checkout flow'), 'merged', { rounds: 4, timeSec: 360, reviewFindings: 2, errors: ['review_conflict'], files: ['src/checkout.ts'], timestamp: '2026-03-18T12:10:00.000Z' });
  const content = await readFile(join(repo, '.agentloop', 'metrics.jsonl'), 'utf-8');
  expect(content.trim().split('\n')).toHaveLength(2);
});
