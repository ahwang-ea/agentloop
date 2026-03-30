import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentloopConfig, TaskDefinition } from '../types/index.js';

const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
export const normalizeBranchPrefix = (prefix: string) => prefix.endsWith('/') ? prefix : `${prefix}/`;
export const withBranchPrefix = (config: Pick<AgentloopConfig, 'branchPrefix'>, name: string) => {
  const branch = name.replace(/^\/+/, '');
  const prefix = normalizeBranchPrefix(config.branchPrefix);
  return branch.startsWith(prefix) ? branch : `${prefix}${branch}`;
};
export const worktreeRootPath = (config: Pick<AgentloopConfig, 'worktreeRoot'>) =>
  config.worktreeRoot.startsWith('~/') ? join(homedir(), config.worktreeRoot.slice(2)) : config.worktreeRoot;
export const worktreePathForBranch = (
  config: Pick<AgentloopConfig, 'branchPrefix' | 'repoPath' | 'worktreeRoot'>, branch: string,
) => join(worktreeRootPath(config), basename(config.repoPath), withBranchPrefix(config, branch));
export const baseWorktreePath = (config: Pick<AgentloopConfig, 'repoPath' | 'worktreeRoot'>, base: string) =>
  join(worktreeRootPath(config), basename(config.repoPath), '_base', base);
export const taskBranchName = (task: TaskDefinition) => slugify(task.title) || task.id.slice(0, 8);
