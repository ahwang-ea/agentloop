import { runVerify, truncateVerifyOutput } from '../verifier.js';

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line-${index + 1}`).join('\n');

test('keeps short verify output unchanged', () => {
  expect(truncateVerifyOutput(lines(100))).toBe(lines(100));
});

test('truncates long verify output to the first 50 and last 10 lines', () => {
  const output = truncateVerifyOutput(lines(101)).split('\n');
  expect(output).toHaveLength(61);
  expect(output[0]).toBe('line-1');
  expect(output[49]).toBe('line-50');
  expect(output[50]).toBe('... (truncated) ...');
  expect(output[51]).toBe('line-92');
  expect(output[60]).toBe('line-101');
});

test('passes extra environment variables to the verify command', async () => {
  const result = await runVerify('printf %s "$AGENTLOOP_MERGE_CHECK"; exit 1', process.cwd(), { ...process.env, AGENTLOOP_MERGE_CHECK: '1' });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.pass).toBe(false);
  expect(result.value.output).toBe('1');
});
