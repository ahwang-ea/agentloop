import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { ok } from '../../shared/result.js';
import { architectSweep } from '../sweep.js';
import { createFileTaskQueue } from '../task-queue.js';

const repo = () => mkdtemp(join(tmpdir(), 'agentloop-sweep-'));
const config = (repoPath: string) => ({
  repoPath,
  baseBranch: 'main',
  branchPrefix: 'al/',
  worktreeRoot: '~/.agentloop/worktrees',
  verifyCommand: './verify.sh',
  agentsMdPath: join(repoPath, 'AGENTS.md'),
  architectureMdPath: join(repoPath, 'ARCHITECTURE.md'),
  claudeModel: 'c',
  codexModel: 'o',
  codexEnabled: true,
  convergence: { maxWallClock: 1, maxTokens: 1, stuckThreshold: 1, thrashOverlapRatio: 0.5 },
  taskSource: 'file' as const,
  taskFilePath: join(repoPath, 'tasks.json'),
  maxParallelAgents: 1,
  maxTasksPerSession: 3,
  maxTokensPerSession: 100000,
  parallelVerify: true,
  sweepInterval: 1,
});
const task = (title: string) => ({
  title,
  description: '',
  scope: { editableFiles: ['**/*'], readOnlyContext: [], forbiddenFiles: [] },
  acceptanceCriteria: [],
  priority: 'low' as const,
});

test('prioritizes deterministic sweep tasks before proposed tasks when the cap is nearly full', async () => {
  const repoPath = await repo();
  await mkdir(join(repoPath, '.agentloop'), { recursive: true });
  await writeFile(join(repoPath, 'AGENTS.md'), '# AGENTS\n', 'utf-8');
  await writeFile(join(repoPath, 'ARCHITECTURE.md'), '# ARCH\n', 'utf-8');
  await writeFile(join(repoPath, 'package.json'), JSON.stringify({ name: 'repo' }), 'utf-8');
  const queue = createFileTaskQueue(config(repoPath));
  for (let index = 0; index < 9; index += 1) {
    const added = await queue.ensureTask(`sweep:existing:${index}`, task(`Existing ${index}`));
    expect(added.ok).toBe(true);
  }
  const sent: Array<{ summary: string; details: string }> = [];
  const claude = {
    chat: jest.fn(async () => ok({
      text: JSON.stringify([
        { title: 'Duplicate title', description: 'first', editableFiles: ['src/a.ts'] },
        { title: 'Duplicate title', description: 'second', editableFiles: ['src/b.ts'] },
        { title: 'Would exceed cap', description: 'third', editableFiles: ['src/c.ts'] },
      ]),
      tokensDelta: 0,
      changedFiles: [],
      stopReason: 'end_turn' as const,
    })),
  };
  const result = await architectSweep({
    config: config(repoPath),
    queue,
    notifier: { send: async notification => { sent.push({ summary: notification.summary, details: notification.details }); return ok(undefined); } },
    claude: claude as never,
  });
  expect(result.ok).toBe(true);
  expect(await queue.countByDedupePrefix('sweep:')).toEqual(ok(10));
  const raw = JSON.parse(await readFile(join(repoPath, 'tasks.json'), 'utf-8')) as Array<{ task: { title: string } }> | { version: number; tasks: Array<{ task: { title: string } }> };
  const titles = (Array.isArray(raw) ? raw : raw.tasks).map(item => item.task.title);
  expect(titles).toContain('Review oversized file tasks.json');
  expect(titles).not.toContain('Duplicate title');
  expect(titles).not.toContain('Would exceed cap');
  expect(claude.chat).not.toHaveBeenCalled();
  expect(sent[0]).toEqual({ summary: 'Architect sweep: 1 tasks queued', details: 'Review oversized file tasks.json' });
});
