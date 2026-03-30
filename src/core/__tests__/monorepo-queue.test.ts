import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileTaskQueue } from '../task-queue.js';

const config = (repoPath: string) => ({
  repoPath,
  baseBranch: 'main',
  branchPrefix: 'al/',
  worktreeRoot: '~/.agentloop/worktrees',
  verifyCommand: './verify.sh',
  agentsMdPath: 'AGENTS.md',
  architectureMdPath: 'ARCHITECTURE.md',
  claudeModel: 'c', codexModel: 'o', codexEnabled: true,
  convergence: { maxWallClock: 1, maxTokens: 1, stuckThreshold: 1, thrashOverlapRatio: 0.5 },
  taskSource: 'file' as const, taskFilePath: 'tasks.json', maxParallelAgents: 1, parallelVerify: true, sweepInterval: 1,
});
const inventory = {
  scannedAt: '', files: [], monorepo: true,
  packages: [{ name: 'root', path: '.' }, { name: 'orders', path: 'packages/orders' }, { name: 'shared', path: 'packages/shared' }],
  crossPackageImports: ['orders -> shared'], patterns: { resultCount: 0, tryCatchCount: 0, serviceFileCount: 0, controllerFileCount: 0 },
  tests: { frameworks: [], count: 0 }, docs: [], dependencies: [], env: { example: [], referenced: [], missingInExample: [], unusedInExample: [] }, oversizedFiles: [], ci: [], importFrequency: [],
};

test('queue rejects cross-package writes in monorepos', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-mono-queue-'));
  await mkdir(join(repoPath, '.agentloop'), { recursive: true });
  await writeFile(join(repoPath, '.agentloop', 'inventory.json'), JSON.stringify(inventory), 'utf-8');
  const added = await createFileTaskQueue(config(repoPath)).add({
    title: 'Cross package', description: '',
    scope: { editableFiles: ['packages/orders/**/*', 'packages/shared/**/*'], readOnlyContext: [], forbiddenFiles: [] },
    acceptanceCriteria: [], model: 'auto', priority: 'medium',
  });
  expect(added.ok).toBe(false);
});

test('queue injects shared-package read-only scope for feature tasks', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-mono-queue-'));
  await mkdir(join(repoPath, '.agentloop'), { recursive: true });
  await writeFile(join(repoPath, '.agentloop', 'inventory.json'), JSON.stringify(inventory), 'utf-8');
  const added = await createFileTaskQueue(config(repoPath)).add({
    title: 'Orders feature', description: '', feature: 'checkout',
    scope: { editableFiles: ['packages/orders/**/*'], readOnlyContext: [], forbiddenFiles: [] },
    acceptanceCriteria: [], model: 'auto', priority: 'medium',
  });
  expect(added.ok).toBe(true);
  if (!added.ok) return;
  expect(added.value.scope.forbiddenFiles).toContain('packages/shared/**/*');
  expect(added.value.scope.readOnlyContext).toContain('packages/shared/MODULE.md');
});
