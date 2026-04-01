import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTaskQueue, saveTaskQueue } from '../task-queue-store.js';

const taskRecord = (id: string) => ({
  task: {
    id,
    title: `Task ${id}`,
    description: '',
    type: 'implement' as const,
    scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] },
    acceptanceCriteria: [],
    priority: 'medium' as const,
    createdAt: '2026-04-01T00:00:00.000Z',
  },
  status: 'queued' as const,
  round: 0,
  startedAt: '2026-04-01T00:00:00.000Z',
});

test('saveTaskQueue preserves wrapped queue files', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-queue-store-'));
  const taskFile = join(repoPath, 'tasks.json');
  await writeFile(taskFile, JSON.stringify({ version: 1, tasks: [taskRecord('wrapped')] }, null, 2), 'utf-8');
  const loaded = await loadTaskQueue(taskFile);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  expect(loaded.value.version).toBe(1);
  loaded.value.tasks[0].status = 'stuck';
  loaded.value.tasks[0].stuckReason = 'dependency failed';
  const saved = await saveTaskQueue(taskFile, loaded.value);
  expect(saved.ok).toBe(true);
  const raw = JSON.parse(await readFile(taskFile, 'utf-8')) as { version: number; tasks: Array<{ status: string; stuckReason?: string }> };
  expect(raw.version).toBe(1);
  expect(raw.tasks[0]).toMatchObject({ status: 'stuck', stuckReason: 'dependency failed' });
});

test('saveTaskQueue keeps legacy queue arrays bare', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-queue-store-'));
  const taskFile = join(repoPath, 'tasks.json');
  await writeFile(taskFile, JSON.stringify([taskRecord('legacy')], null, 2), 'utf-8');
  const loaded = await loadTaskQueue(taskFile);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  expect(loaded.value.version).toBeUndefined();
  loaded.value.tasks[0].status = 'done';
  const saved = await saveTaskQueue(taskFile, loaded.value);
  expect(saved.ok).toBe(true);
  const raw = JSON.parse(await readFile(taskFile, 'utf-8')) as Array<{ status: string }>;
  expect(Array.isArray(raw)).toBe(true);
  expect(raw[0].status).toBe('done');
});
