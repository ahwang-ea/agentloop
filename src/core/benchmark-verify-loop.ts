import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile), npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const runTests = (repoPath: string) => exec(
  npm,
  ['test', '--', '--maxWorkers=100%', '--testPathIgnorePatterns', 'golden\\.test\\.ts$'],
  { cwd: repoPath, timeout: 180_000 },
).then(() => true, () => false);

export async function verifyAndRetry(
  repoPath: string,
  deps: { queue: { list: () => Promise<any> }; config: any; [key: string]: any },
  runOrchestrator: (deps: any, deadline: number) => Promise<any>,
  deadlineAt: number,
  log: (message: string) => void,
): Promise<{ retried: boolean; testsPassed: boolean }> {
  if (await runTests(repoPath)) return { retried: false, testsPassed: true };
  if (Date.now() + 180_000 >= deadlineAt) return { retried: false, testsPassed: false };
  log('tests failed, retrying orchestrator with remaining budget');
  await runOrchestrator(deps, deadlineAt);
  return { retried: true, testsPassed: await runTests(repoPath) };
}
