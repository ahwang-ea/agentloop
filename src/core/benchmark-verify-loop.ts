import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile), npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const testOutput = (value?: string | Buffer) => typeof value === 'string' ? value : value?.toString();
const runTests = async (repoPath: string): Promise<{ passed: boolean; output?: string }> => {
  try {
    await exec(
      npm,
      ['test', '--', '--maxWorkers=100%', '--testPathIgnorePatterns', 'golden\\.test\\.ts$'],
      { cwd: repoPath, timeout: 180_000, maxBuffer: 10_000_000 },
    );
    return { passed: true };
  } catch (e) {
    const error = e as { stdout?: string | Buffer; stderr?: string | Buffer };
    const output = [testOutput(error.stderr), testOutput(error.stdout)].filter(Boolean).join('\n').slice(-3000);
    return { passed: false, output: output || undefined };
  }
};

export async function verifyAndRetry(
  repoPath: string,
  deps: { queue: { list: () => Promise<any> }; config: any; [key: string]: any },
  runOrchestrator: (deps: any, deadline: number, failureOutput?: string) => Promise<any>,
  deadlineAt: number,
  log: (message: string) => void,
): Promise<{ retried: boolean; testsPassed: boolean; failureOutput?: string }> {
  const initial = await runTests(repoPath);
  if (initial.passed) return { retried: false, testsPassed: true };
  if (Date.now() + 180_000 >= deadlineAt) return { retried: false, testsPassed: false, failureOutput: initial.output };
  if (initial.output) log(`test failure output:\n${initial.output}`);
  log('tests failed, retrying orchestrator with remaining budget');
  await runOrchestrator({ ...deps, failureOutput: initial.output }, deadlineAt, initial.output);
  return { retried: true, testsPassed: (await runTests(repoPath)).passed, failureOutput: initial.output };
}
