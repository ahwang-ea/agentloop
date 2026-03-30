import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  model: 'auto' as const,
  priority: 'low' as const,
});

test('dedupes proposed sweep titles and caps live sweep tasks at ten', async () => {
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
  const result = await architectSweep({
    config: config(repoPath),
    queue,
    notifier: { send: async notification => { sent.push({ summary: notification.summary, details: notification.details }); return ok(undefined); } },
    claude: { chat: async () => ok({ text: JSON.stringify([
      { title: 'Duplicate title', description: 'first', editableFiles: ['src/a.ts'] },
      { title: 'Duplicate title', description: 'second', editableFiles: ['src/b.ts'] },
      { title: 'Would exceed cap', description: 'third', editableFiles: ['src/c.ts'] },
    ]), tokensDelta: 0, changedFiles: [], stopReason: 'end_turn' }) } as never,
  });
  expect(result.ok).toBe(true);
  expect(await queue.countByDedupePrefix('sweep:')).toEqual(ok(10));
  const tasks = JSON.parse(await readFile(join(repoPath, 'tasks.json'), 'utf-8')) as Array<{ task: { title: string } }>;
  expect(tasks.map(item => item.task.title)).toContain('Duplicate title');
  expect(tasks.map(item => item.task.title)).not.toContain('Would exceed cap');
  expect(sent[0]).toEqual({ summary: 'Architect sweep: 1 tasks queued', details: 'Duplicate title' });
});
