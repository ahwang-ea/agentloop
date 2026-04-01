import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentloopConfig, TaskDefinition } from '../types/index.js';

const TASK_ID_SUFFIX_LEN = 8;
const TASK_BRANCH_NAME_LEN = 40;
const TASK_BRANCH_SLUG_LEN = TASK_BRANCH_NAME_LEN - TASK_ID_SUFFIX_LEN - 1;

const slugify = (value: string, max = TASK_BRANCH_NAME_LEN) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max);
const taskIdSuffix = (taskId: string) => taskId.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, TASK_ID_SUFFIX_LEN);
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
export const taskBranchName = (task: TaskDefinition) => {
  const suffix = taskIdSuffix(task.id);
  const slug = slugify(task.title, TASK_BRANCH_SLUG_LEN);
  return slug ? `${slug}-${suffix || 'task'}` : suffix ? `task-${suffix}` : 'task';
};
