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

test('parses jest empty-test failures with the failing file', async () => {
  const result = await runVerify("cat <<'EOF'\nFAIL src/__tests__/deal.service.test.ts\n  ● Test suite failed to run\n\n    Your test suite must contain at least one test.\nEOF\nexit 1");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.pass).toBe(false);
  expect(result.value.errors).toEqual([
    expect.objectContaining({
      source: 'test',
      file: 'src/__tests__/deal.service.test.ts',
      message: 'Your test suite must contain at least one test.',
    }),
  ]);
});


test('parses jest assertion failures with the failing file', async () => {
  const result = await runVerify(String.raw`cat <<'EOF'
FAIL src/__tests__/note.service.test.ts
  ● note.service › createNote › returns duplicate id

    expect(received).toBe(expected) // Object.is equality

    Expected: "DUPLICATE_ID"
    Received: "INVALID_INPUT"

      at Object.<anonymous> (src/__tests__/note.service.test.ts:18:36)
EOF
exit 1`);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.pass).toBe(false);
  expect(result.value.errors).toEqual([
    expect.objectContaining({
      source: 'test',
      file: 'src/__tests__/note.service.test.ts',
      line: 18,
      message: 'note.service › createNote › returns duplicate id — Expected: "DUPLICATE_ID"; Received: "INVALID_INPUT"',
    }),
  ]);
});


test('parses jest object diffs when Expected/Received lines are absent', async () => {
  const result = await runVerify(String.raw`cat <<'EOF'
FAIL src/__tests__/db.test.ts
  ● contactRowToEntity / contactEntityToRow › maps a full contact row to camelCase entity

    expect(received).toEqual(expected) // deep equality

    - Expected  - 2
    + Received  + 2

      Object {
    -   "firstName": "Alice",
    -   "id": "c1",
    +   "firstName": "",
    +   "id": "",
      }

      at Object.<anonymous> (src/__tests__/db.test.ts:103:20)
EOF
exit 1`);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.errors).toEqual([
    expect.objectContaining({
      source: 'test',
      file: 'src/__tests__/db.test.ts',
      line: 103,
      message: expect.stringContaining('Diff: Object { -   "firstName": "Alice", -   "id": "c1", +   "firstName": "", +   "id": ""'),
    }),
  ]);
});


test('parses doc-freshness warnings when verify fails', async () => {
  const result = await runVerify("printf 'WARNING: doc-freshness: 2 src/*.ts files changed without AGENTS.md or ARCHITECTURE.md updates\n'; exit 1");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.errors).toEqual([
    expect.objectContaining({ source: 'doc-freshness', message: '2 src/*.ts files changed without AGENTS.md or ARCHITECTURE.md updates' }),
  ]);
});
