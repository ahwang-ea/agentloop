import { homedir } from 'node:os';
import { baseWorktreePath, taskBranchName, withBranchPrefix, worktreePathForBranch } from '../worktree.js';

const config = { branchPrefix: 'al/', repoPath: '/tmp/agentloop-demo', worktreeRoot: '~/.agentloop/worktrees' };
const task = (id: string, title: string) => ({
  id,
  title,
  description: '',
  acceptanceCriteria: [],
  createdAt: '',
  type: 'implement' as const,
  priority: 'medium' as const,
  scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] },
});

test('adds branch prefix only once', () => {
  expect(withBranchPrefix(config, 'orders')).toBe('al/orders');
  expect(withBranchPrefix(config, 'al/orders')).toBe('al/orders');
});

test('builds deterministic worktree paths', () => {
  expect(worktreePathForBranch(config, 'orders')).toBe(`${homedir()}/.agentloop/worktrees/agentloop-demo/al/orders`);
  expect(baseWorktreePath(config, 'main')).toBe(`${homedir()}/.agentloop/worktrees/agentloop-demo/_base/main`);
});

test('derives readable task branch names', () => {
  expect(taskBranchName(task('abc12345', 'Feature Webhooks!'))).toBe('feature-webhooks-abc12345');
});

test('keeps duplicate task titles on distinct worktree branches', () => {
  const first = taskBranchName(task('abc12345-0000', 'Feature Webhooks!'));
  const second = taskBranchName(task('def67890-0000', 'Feature Webhooks!'));

  expect(first).toBe('feature-webhooks-abc12345');
  expect(second).toBe('feature-webhooks-def67890');
  expect(first).not.toBe(second);
  expect(worktreePathForBranch(config, first)).toBe(`${homedir()}/.agentloop/worktrees/agentloop-demo/al/${first}`);
  expect(worktreePathForBranch(config, second)).toBe(`${homedir()}/.agentloop/worktrees/agentloop-demo/al/${second}`);
});
