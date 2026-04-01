import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logInferredTaskMetrics, logMetrics, metricsFromTaskState, recordReviewFindings, recordSessionChanges, recordVerifyErrors } from '../metrics.js';
import { parseMetrics, readMetricsSummary } from '../metrics-report.js';
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
  expect(stats).toEqual({ rounds: 2, timeSec: 300, reviewFindings: 1, errors: ['checkout_fails_on_timeout', 'rename_helper'], files: ['src/checkout.ts'], timestamp: '2026-03-18T00:05:00.000Z', taskType: 'implement', tokenTotal: 30, verifyTimeSec: 3 });
  const logged = await logMetrics({ repoPath: repo }, task('t1', 'Checkout flow'), 'merged', stats);
  expect(logged.ok).toBe(true);
  const content = await readFile(join(repo, '.agentloop', 'metrics.jsonl'), 'utf-8');
  expect(content).toContain('"version":2');
  expect(content).toContain('"task_id":"t1"');
  expect(content).toContain('"outcome":"merged"');
  expect(content).toContain('"time_sec":300');
  expect(content).toContain('"review_findings":1');
  expect(content).toContain('"task_type":"implement"');
  expect(content).toContain('"token_total":30');
  expect(content).toContain('"verify_time_sec":3');
});

test('uses needs-human outcome for blocked debug tasks', async () => {
  const repo = await repoPath();
  const queue = { list: async () => ({ ok: true as const, value: [{ task: task('dbg', 'Debug checkout', 'debug'), status: 'blocked', round: 0, startedAt: '', blocked: { reason: 'Need human', details: {}, blockedAt: '2026-03-18T00:05:00.000Z' } }] }) };
  const logged = await logInferredTaskMetrics({ repoPath: repo }, queue as never, task('dbg', 'Debug checkout', 'debug'));
  expect(logged.ok).toBe(true);
  expect(await readFile(join(repo, '.agentloop', 'metrics.jsonl'), 'utf-8')).toContain('"outcome":"needs-human"');
});

test('dedupes metrics summaries by latest timestamp', async () => {
  const parsed = parseMetrics([
    JSON.stringify({ version: 2, task_id: 'same', task: 'Checkout flow', rounds: 4, time_sec: 360, review_findings: 2, task_type: 'implement', token_total: 144, verify_time_sec: 21, outcome: 'merged', errors: ['review_conflict'], files: ['src/checkout.ts'], timestamp: '2026-03-18T12:10:00.000Z' }),
    JSON.stringify({ task_id: 'same', task: 'Checkout flow', rounds: 3, time_sec: 300, review_findings: 2, outcome: 'blocked', errors: ['review_conflict'], files: ['src/checkout.ts'], timestamp: '2026-03-18T12:00:00.000Z' }),
  ].join('\n'), 'metrics.jsonl');
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value).toHaveLength(1);
  expect(parsed.value[0]).toMatchObject({ version: 2, outcome: 'merged', timeSec: 360, timestamp: '2026-03-18T12:10:00.000Z', taskType: 'implement', tokenTotal: 144, verifyTimeSec: 21 });
});

test('counts first-pass only for merged one-round tasks', async () => {
  const repo = await repoPath();
  await mkdir(join(repo, '.agentloop'), { recursive: true });
  await writeFile(join(repo, '.agentloop', 'metrics.jsonl'), [
    JSON.stringify({ task_id: 'done', task: 'Done', rounds: 1, time_sec: 10, review_findings: 0, outcome: 'merged', errors: [], files: [], timestamp: '2026-03-31T12:00:00.000Z' }),
    JSON.stringify({ task_id: 'stuck', task: 'Stuck', rounds: 1, time_sec: 10, review_findings: 0, outcome: 'stuck', errors: [], files: [], timestamp: '2026-03-31T12:01:00.000Z' }),
  ].join('\n'), 'utf-8');
  const summary = await readMetricsSummary({ repoPath: repo });
  expect(summary.ok).toBe(true);
  if (!summary.ok) return;
  expect(summary.value.last7.firstPassRate).toBe(50);
});

test('serializes concurrent metrics writes', async () => {
  const repo = await repoPath();
  const writes = Array.from({ length: 24 }, (_, i) => logMetrics(
    { repoPath: repo }, task(`t${i}`, `Task ${i}`), 'merged',
    { rounds: 1, timeSec: i + 1, reviewFindings: 0, errors: [`error_${i}`], files: [`src/file-${i}.ts`], timestamp: `2026-03-18T00:${String(i).padStart(2, '0')}:00.000Z` },
  ));
  const results = await Promise.all(writes);
  expect(results.every(result => result.ok)).toBe(true);
  const lines = (await readFile(join(repo, '.agentloop', 'metrics.jsonl'), 'utf-8')).trim().split('\n');
  expect(lines).toHaveLength(24);
  expect(new Set(lines.map(line => (JSON.parse(line) as { task_id: string }).task_id)).size).toBe(24);
});
