import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { err, ok, type Result } from '../shared/result.js';

const exec = promisify(execFile);
const uniqueLines = (text: string) => [...new Set(text.split('\n').map(line => line.trim()).filter(Boolean))];
const gitErrorText = (error: unknown) => {
  const details = error as { stdout?: string; stderr?: string; message?: string };
  return [details.stderr, details.stdout, details.message].filter(Boolean).join('\n').trim() || 'unknown git error';
};
const mapGitError = (error: unknown, action: string): Result<never> => {
  const message = gitErrorText(error);
  const code = /CONFLICT|conflict/.test(message) ? 'MERGE_CONFLICT'
    : /pathspec|did not match any file/.test(message) ? 'BRANCH_NOT_FOUND'
    : /local changes|Please commit your changes/.test(message) ? 'DIRTY_TREE'
    : 'GIT_ERROR';
  return err(code, `${action}: ${message}`);
};

export interface GitRunner {
  exists(path: string): Promise<boolean>;
  run(cwd: string, action: string, args: string[]): Promise<Result<string>>;
  runRoot(action: string, args: string[]): Promise<Result<string>>;
  listFiles(cwd: string, args: string[]): Promise<Result<string[]>>;
  noIndexDiff(cwd: string, file: string): Promise<Result<string>>;
}

export function createGitRunner(repoPath: string): GitRunner {
  const run = async (cwd: string, action: string, args: string[]): Promise<Result<string>> => {
    try {
      const { stdout, stderr } = await exec('git', args, { cwd });
      return ok(`${stdout}${stderr}`.trim());
    } catch (error) { return mapGitError(error, action); }
  };
  return {
    exists: path => access(path, constants.F_OK).then(() => true).catch(() => false),
    run,
    runRoot: (action, args) => run(repoPath, action, args),
    async listFiles(cwd, args) {
      try { return ok(uniqueLines((await exec('git', args, { cwd })).stdout)); }
      catch (error) { return /did not match any file/.test(gitErrorText(error)) ? ok([]) : err('GIT_ERROR', `listFiles: ${gitErrorText(error)}`); }
    },
    async noIndexDiff(cwd, file) {
      try {
        return ok((await exec('git', ['diff', '--no-index', '--binary', '--src-prefix=a/', '--dst-prefix=b/', '--', '/dev/null', file], { cwd })).stdout.trim());
      } catch (error) {
        const diff = error as { code?: number; stdout?: string };
        return diff.code === 1 ? ok((diff.stdout ?? '').trim()) : err('GIT_ERROR', `untrackedDiff(${file}): ${gitErrorText(error)}`);
      }
    },
  };
}
