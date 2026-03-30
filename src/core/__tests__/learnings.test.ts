import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from '../../shared/result.js';
import { learningsAddendum, maybeProposeAgentsUpdate, syncLearnings } from '../learnings.js';

const repo = async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-learnings-'));
  await mkdir(join(repoPath, '.agentloop'), { recursive: true });
  return repoPath;
};
const config = (repoPath: string) => ({ repoPath, agentsMdPath: 'AGENTS.md' } as const);
const task = { id: 't', title: 'Orders', description: '', type: 'implement' as const, scope: { editableFiles: ['src/orders/service.ts'], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], priority: 'medium' as const, createdAt: '' };

async function writeMetrics(repoPath: string, count: number, pattern = 'missing_id_validation') {
  const lines = Array.from({ length: count }, (_, i) => JSON.stringify({ task_id: `t${i}`, task: `Task ${i}`, outcome: 'blocked', errors: [pattern], files: ['src/orders/service.ts'], rounds: 1, time_sec: 1, review_findings: 0, timestamp: `2026-03-${String((i % 30) + 1).padStart(2, '0')}T00:00:00.000Z` }));
  await writeFile(join(repoPath, '.agentloop', 'metrics.jsonl'), `${lines.join('\n')}\n`, 'utf-8');
}

test('aggregates recent metrics into learnings.json', async () => {
  const repoPath = await repo();
  await writeMetrics(repoPath, 3);
  const synced = await syncLearnings({ repoPath });
  expect(synced.ok).toBe(true);
  const learnings = JSON.parse(await readFile(join(repoPath, '.agentloop', 'learnings.json'), 'utf-8')) as Array<{ module: string; pattern: string; count: number }>;
  expect(learnings[0]).toMatchObject({ module: 'orders', pattern: 'missing id validation', count: 3 });
});

test('replaces stale learnings with recent hotspots', async () => {
  const repoPath = await repo();
  await writeFile(join(repoPath, '.agentloop', 'learnings.json'), JSON.stringify([{ pattern: 'legacy issue', module: 'legacy', count: 99, lastSeen: '2026-03-01', suggestion: 'legacy' }], null, 2), 'utf-8');
  await writeMetrics(repoPath, 2);
  const synced = await syncLearnings({ repoPath });
  expect(synced.ok).toBe(true);
  const learnings = JSON.parse(await readFile(join(repoPath, '.agentloop', 'learnings.json'), 'utf-8')) as Array<{ module: string }>;
  expect(learnings.some(item => item.module === 'legacy')).toBe(false);
});

test('injects only matching learnings into prompts', async () => {
  const repoPath = await repo();
  await writeFile(join(repoPath, '.agentloop', 'learnings.json'), JSON.stringify([
    { pattern: 'missing ID validation', module: 'orders', count: 7, lastSeen: '2026-03-30', suggestion: 'add validation' },
    { pattern: 'forgot updatedAt timestamp', module: 'billing', count: 2, lastSeen: '2026-03-29', suggestion: 'set timestamp' },
  ], null, 2), 'utf-8');
  const addendum = await learningsAddendum({ repoPath }, task);
  expect(addendum.ok && addendum.value).toContain('missing ID validation');
  expect(addendum.ok && addendum.value).not.toContain('updatedAt');
});

test('writes proposal on every twentieth task and notifies', async () => {
  const repoPath = await repo();
  await writeMetrics(repoPath, 20);
  await writeFile(join(repoPath, 'AGENTS.md'), '# AGENTS\n', 'utf-8');
  const proposed = await maybeProposeAgentsUpdate(config(repoPath), { chat: async () => ok({ text: '--- AGENTS.md\n+++ AGENTS.md\n@@\n+# New rule', tokensDelta: 0, changedFiles: [], stopReason: 'end_turn' }) }, { send: async () => ok(undefined) });
  expect(proposed.ok && proposed.value).toBe(true);
  expect(await readFile(join(repoPath, '.agentloop', 'proposed-agents-update.md'), 'utf-8')).toContain('AGENTS.md');
});

test('rejects proposals that exceed the AGENTS line cap', async () => {
  const repoPath = await repo();
  await writeMetrics(repoPath, 20);
  await writeFile(join(repoPath, 'AGENTS.md'), `${Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n')}\n`, 'utf-8');
  const proposed = await maybeProposeAgentsUpdate(config(repoPath), { chat: async () => ok({ text: '--- AGENTS.md\n+++ AGENTS.md\n@@\n+# New rule', tokensDelta: 0, changedFiles: [], stopReason: 'end_turn' }) }, { send: async () => ok(undefined) });
  expect(proposed.ok).toBe(false);
  expect(!proposed.ok && proposed.error.code).toBe('CONFIG_ERROR');
});
