import { jest } from '@jest/globals';
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldRepo } from '../init.js';
import { readStatusSummary } from '../status.js';

const repo = () => mkdtemp(join(tmpdir(), 'agentloop-session-status-'));
const exists = (path: string) => access(path, constants.F_OK).then(() => true).catch(() => false);
const config = (repoPath: string) => ({ repoPath, taskFilePath: 'tasks.json' } as never);

afterEach(() => {
  jest.restoreAllMocks();
});

test('scaffold does not create the deprecated session status artifact', async () => {
  const repoPath = await repo();
  const result = await scaffoldRepo(repoPath, { smartInit: false });
  expect(result.ok).toBe(true);
  expect(await exists(join(repoPath, '.agentloop', 'session-status.json'))).toBe(false);
});

test('status summary ignores stale session status content', async () => {
  const repoPath = await repo();
  await mkdir(join(repoPath, '.agentloop'), { recursive: true });
  await writeFile(join(repoPath, '.agentloop', 'session-status.json'), '{not-json', 'utf-8');
  await writeFile(join(repoPath, 'tasks.json'), JSON.stringify([
    { status: 'queued', task: { id: 'task-1', title: 'Queued task' }, round: 0, startedAt: '2026-04-01T00:00:00.000Z' },
    { status: 'reviewing', task: { id: 'task-2', title: 'Active task' }, round: 0, startedAt: '2026-04-01T00:00:00.000Z' },
    { status: 'done', task: { id: 'task-3', title: 'Done task' }, round: 0, startedAt: '2026-04-01T00:00:00.000Z', completedAt: '2026-04-01T00:10:00.000Z' },
    { status: 'stuck', task: { id: 'task-4', title: 'Stuck task' }, round: 0, startedAt: '2026-04-01T00:00:00.000Z', stuckReason: 'Needs investigation' },
    { status: 'blocked', task: { id: 'task-5', title: 'Blocked task' }, round: 0, startedAt: '2026-04-01T00:00:00.000Z', blocked: { reason: 'Awaiting approval', details: {}, blockedAt: '2026-04-01T00:05:00.000Z' } },
  ], null, 2), 'utf-8');

  const result = await readStatusSummary(config(repoPath));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toEqual({
    queued: 1,
    active: 1,
    done: 1,
    stuck: 1,
    blocked: 1,
    blockedTasks: [{ id: 'task-5', title: 'Blocked task', reason: 'Awaiting approval' }],
    stuckTasks: [{ title: 'Stuck task', reason: 'Needs investigation' }],
  });
});
