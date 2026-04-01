import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok } from '../../shared/result.js';
import { runParallelChecks, type ConcernCheck } from '../parallel-check.js';
import { runDeterministicChecks } from '../review-concerns.js';

const repo = () => mkdtemp(join(tmpdir(), 'agentloop-concerns-'));

test('finds deterministic review concerns from a diff and changed files', async () => {
  const cwd = await repo();
  await mkdir(join(cwd, 'src'), { recursive: true });
  await writeFile(join(cwd, 'src', 'widget.ts'), [
    'export const unused = 1;',
    'export function widget(value) {',
    '  const cast = value as string;',
    '  try { return cast; } catch { return ""; }',
    '}',
    ...Array.from({ length: 160 }, () => 'export const pad = 1;'),
  ].join('\n'), 'utf-8');
  const diff = [
    'diff --git a/src/widget.ts b/src/widget.ts',
    '--- a/src/widget.ts',
    '+++ b/src/widget.ts',
    '@@ -0,0 +1,4 @@',
    '+export const unused = 1;',
    '+export function widget(value) {',
    '+  const cast = value as string;',
    '+  return cast as any;',
  ].join('\n');
  const result = await runDeterministicChecks(cwd, diff, 'context');
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.map(finding => finding.topicKey)).toEqual(expect.arrayContaining([
    'type_safety', 'test_coverage', 'file_size', 'pattern_drift', 'dead_code',
  ]));
});

test('type safety ignores safe patterns but still flags real issues', async () => {
  const cwd = await repo();
  await mkdir(join(cwd, 'src'), { recursive: true });
  await writeFile(join(cwd, 'src', 'widget.ts'), [
    "import { dep as renamed } from './dep.js';",
    'const palette = { ok: true } as const;',
    '// any and as string should stay ignored here',
    'export function loose(value) {',
    '  const cast = value as unknown as Widget;',
    '  return cast;',
    '}',
  ].join('\n'), 'utf-8');
  await writeFile(join(cwd, 'src', 'widget.test.ts'), 'export {}\n', 'utf-8');
  const diff = [
    'diff --git a/src/widget.ts b/src/widget.ts',
    '--- a/src/widget.ts',
    '+++ b/src/widget.ts',
    '@@ -0,0 +1,7 @@',
    "+import { dep as renamed } from './dep.js';",
    '+const palette = { ok: true } as const;',
    '+// any and as string should stay ignored here',
    '+export function loose(value) {',
    '+  const cast = value as unknown as Widget;',
    '+  return cast;',
    '+}',
    'diff --git a/src/widget.test.ts b/src/widget.test.ts',
    '--- a/src/widget.test.ts',
    '+++ b/src/widget.test.ts',
    '@@ -0,0 +1 @@',
    '+export {};',
  ].join('\n');
  const result = await runDeterministicChecks(cwd, diff, 'context');
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const lines = result.value.filter(finding => finding.topicKey === 'type_safety').map(finding => finding.line);
  expect(lines).toEqual([4, 5]);
});

test('coverage matches related index-module tests by path only', async () => {
  const related = await repo();
  await mkdir(join(related, 'src', 'foo'), { recursive: true });
  await writeFile(join(related, 'src', 'foo', 'index.ts'), 'export const value = 1;\n', 'utf-8');
  await writeFile(join(related, 'src', 'foo', 'foo.test.ts'), 'export {}\n', 'utf-8');
  const relatedDiff = [
    'diff --git a/src/foo/index.ts b/src/foo/index.ts',
    '--- a/src/foo/index.ts',
    '+++ b/src/foo/index.ts',
    '@@ -0,0 +1 @@',
    '+export const value = 1;',
    'diff --git a/src/foo/foo.test.ts b/src/foo/foo.test.ts',
    '--- a/src/foo/foo.test.ts',
    '+++ b/src/foo/foo.test.ts',
    '@@ -0,0 +1 @@',
    '+export {};',
  ].join('\n');
  const relatedResult = await runDeterministicChecks(related, relatedDiff, 'context');
  expect(relatedResult.ok).toBe(true);
  if (!relatedResult.ok) return;
  expect(relatedResult.value.some(finding => finding.topicKey === 'test_coverage')).toBe(false);

  const unrelated = await repo();
  await mkdir(join(unrelated, 'src', 'foo'), { recursive: true });
  await mkdir(join(unrelated, 'src', 'bar'), { recursive: true });
  await writeFile(join(unrelated, 'src', 'foo', 'index.ts'), 'export const value = 1;\n', 'utf-8');
  await writeFile(join(unrelated, 'src', 'bar', 'foo.test.ts'), 'export {}\n', 'utf-8');
  const unrelatedDiff = [
    'diff --git a/src/foo/index.ts b/src/foo/index.ts',
    '--- a/src/foo/index.ts',
    '+++ b/src/foo/index.ts',
    '@@ -0,0 +1 @@',
    '+export const value = 1;',
    'diff --git a/src/bar/foo.test.ts b/src/bar/foo.test.ts',
    '--- a/src/bar/foo.test.ts',
    '+++ b/src/bar/foo.test.ts',
    '@@ -0,0 +1 @@',
    '+export {};',
  ].join('\n');
  const unrelatedResult = await runDeterministicChecks(unrelated, unrelatedDiff, 'context');
  expect(unrelatedResult.ok).toBe(true);
  if (!unrelatedResult.ok) return;
  expect(unrelatedResult.value.some(finding => finding.topicKey === 'test_coverage' && finding.file === 'src/foo/index.ts')).toBe(true);
});

test('parallel checks convert thrown exceptions into Result errors', async () => {
  const checks: ConcernCheck[] = [
    { name: 'ok-check', check: async () => ok([]) },
    { name: 'crash-check', check: async () => { throw new Error('boom'); } },
    { name: 'error-check', check: async () => err('TRANSPORT_ERROR', 'ignored after first failure') },
  ];
  const result = await runParallelChecks(checks, 'diff', 'context');
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'UNKNOWN', message: 'Concern check crash-check failed: boom' }) });
});
