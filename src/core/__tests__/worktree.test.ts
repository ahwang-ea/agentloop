import { homedir } from 'node:os';
import { baseWorktreePath, taskBranchName, withBranchPrefix, worktreePathForBranch } from '../worktree.js';

const config = { branchPrefix: 'al/', repoPath: '/tmp/agentloop-demo', worktreeRoot: '~/.agentloop/worktrees' };

test('adds branch prefix only once', () => {
  expect(withBranchPrefix(config, 'orders')).toBe('al/orders');
  expect(withBranchPrefix(config, 'al/orders')).toBe('al/orders');
});

test('builds deterministic worktree paths', () => {
  expect(worktreePathForBranch(config, 'orders')).toBe(`${homedir()}/.agentloop/worktrees/agentloop-demo/al/orders`);
  expect(baseWorktreePath(config, 'main')).toBe(`${homedir()}/.agentloop/worktrees/agentloop-demo/_base/main`);
});

test('derives readable task branch names', () => {
  expect(taskBranchName({ id: 'abc12345', title: 'Feature Webhooks!', description: '', acceptanceCriteria: [], createdAt: '', type: 'implement', priority: 'medium', scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] } })).toBe('feature-webhooks');
});
