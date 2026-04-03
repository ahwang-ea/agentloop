import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

type JestTestResult = { fullName?: string; status?: string; failureMessages?: string[] };
type JestReport = { testResults?: { testResults?: JestTestResult[]; assertionResults?: JestTestResult[] }[] };
type GoldenTestResult = { name: string; passed: boolean; output?: string };

const exec = promisify(execFile);
const text = (...parts: (string | undefined)[]) => parts.filter(Boolean).join('\n').trim() || undefined;
const parse = (stdout: string): { report?: JestReport; parseError?: string } => {
  const start = stdout.indexOf('{');
  if (start < 0) return { parseError: 'No Jest JSON output found' };
  const candidate = stdout.slice(start);
  try { return { report: JSON.parse(candidate) as JestReport }; }
  catch { /* trailing noise after JSON — find the last } and retry */ }
  const end = candidate.lastIndexOf('}');
  if (end <= 0) return { parseError: 'No valid JSON block found' };
  try { return { report: JSON.parse(candidate.slice(0, end + 1)) as JestReport }; }
  catch (error) { return { parseError: error instanceof Error ? error.message : String(error) }; }
};
const map = (report: JestReport): GoldenTestResult[] => report.testResults?.flatMap(file => file.assertionResults ?? file.testResults ?? []).map(test => ({
  name: `golden: ${test.fullName ?? 'unknown'}`,
  passed: test.status === 'passed',
  output: text((test.failureMessages ?? []).join('\n')),
})) ?? [];

export async function runGoldenTests(repoPath: string): Promise<GoldenTestResult[]> {
  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm', args = ['test', '--', '--testPathPatterns', 'golden', '--json', '--forceExit'];
  try {
    const { stdout, stderr } = await exec(cmd, args, { cwd: repoPath, timeout: 180_000, maxBuffer: 10_000_000 });
    const { report, parseError } = parse(String(stdout ?? ''));
    return report ? map(report) : [{ name: 'golden', passed: false, output: text(parseError, String(stderr ?? ''), String(stdout ?? '')) }];
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string };
    const { report, parseError } = parse(String(failed.stdout ?? ''));
    return report ? map(report) : [{ name: 'golden', passed: false, output: text(failed.message, parseError, String(failed.stderr ?? ''), String(failed.stdout ?? '')) }];
  }
}
