import { jest } from '@jest/globals';

type ExecResult = { stdout: string; stderr: string };

let execImpl: (file: string, args: string[], options?: { cwd?: string; timeout?: number; maxBuffer?: number }) => Promise<ExecResult> = async () => ({ stdout: '', stderr: '' });
const execFile = jest.fn((_file: string, _args: string[], _options: unknown, _callback: unknown) => undefined as never);
(execFile as typeof execFile & { [key: symbol]: unknown })[Symbol.for('nodejs.util.promisify.custom')] = async (file: string, args: string[], options?: { cwd?: string; timeout?: number; maxBuffer?: number }) => {
  execFile(file, args, options, () => undefined);
  return execImpl(file, args, options);
};

await jest.unstable_mockModule('node:child_process', () => ({ execFile }));
const { runGoldenTests } = await import('../benchmark-golden-runner.js');

beforeEach(() => { execFile.mockClear(); execImpl = async () => ({ stdout: '', stderr: '' }); });
afterEach(() => jest.restoreAllMocks());

test('parses individual golden tests from noisy stdout', async () => {
  execImpl = async () => ({ stdout: `warn\n${JSON.stringify({ testResults: [{ testResults: [{ fullName: 'works', status: 'passed', failureMessages: [] }, { fullName: 'breaks', status: 'failed', failureMessages: ['line 1', 'line 2'] }] }] })}\nextra`, stderr: '' });
  const result = await runGoldenTests('/repo');
  expect(execFile).toHaveBeenCalledWith(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test', '--', '--testPathPatterns', 'golden', '--json', '--forceExit'], { cwd: '/repo', timeout: 180_000, maxBuffer: 10_000_000 }, expect.any(Function));
  expect(result).toEqual([{ name: 'golden: works', passed: true }, { name: 'golden: breaks', passed: false, output: 'line 1\nline 2' }]);
});

test('uses stdout json even when jest exits non-zero', async () => {
  execImpl = async () => { throw { code: 1, message: 'Command failed', stderr: 'failed', stdout: `${JSON.stringify({ testResults: [{ testResults: [{ fullName: 'still reported', status: 'failed', failureMessages: ['boom'] }] }] })}\nwarning` }; };
  await expect(runGoldenTests('/repo')).resolves.toEqual([{ name: 'golden: still reported', passed: false, output: 'boom' }]);
});

test('returns a single failed golden result when stdout has no json', async () => {
  execImpl = async () => { throw { code: 1, message: 'missing file', stderr: 'Cannot find golden test', stdout: 'plain text only' }; };
  const result = await runGoldenTests('/repo');
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ name: 'golden', passed: false });
  expect(result[0].output).toContain('missing file');
});
