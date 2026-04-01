import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlanningWorker } from '../planning-worker.js';
import type { TaskState } from '../../types/index.js';
import { ok } from '../../shared/result.js';

const repo = () => mkdtemp(join(tmpdir(), 'agentloop-planning-'));
const task = (id: string, status: TaskState['status'], dependsOn?: string[]): TaskState => ({
  task: { id, title: id, description: '', type: 'implement', scope: { editableFiles: ['src/types.ts'], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], priority: 'medium', createdAt: '', dependsOn },
  status, round: 0, startedAt: '',
});

test('pre-generates scaffolds for queued tasks whose deps are nearly done', async () => {
  const repoPath = await repo();
  const listed = [
    ok([task('dep', 'reviewing'), task('child', 'queued', ['dep'])]),
    ok([]),
  ];
  const result = await runPlanningWorker({
    config: { repoPath } as never,
    queue: { list: async () => listed.shift() ?? ok([]) } as never,
    claude: { scaffold: async () => ok({ files: [{ type: 'types', path: 'src/types.ts', content: 'export type Id = string;\n' }] }) } as never,
  } as never, { sweepCounter: 0, scaffoldPlanning: new Set() }, Date.now() + 2_000);
  expect(result.ok).toBe(true);
  expect(await readFile(join(repoPath, '.agentloop', 'scaffolds', 'child', 'src', 'types.ts'), 'utf-8')).toContain('Id');
});
