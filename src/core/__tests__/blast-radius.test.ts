import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBlastRadiusContext, traceBlastRadius } from '../blast-radius.js';

const repo = () => mkdtemp(join(tmpdir(), 'agentloop-blast-'));

test('traces importers for changed shared types and builds a change manifest', async () => {
  const cwd = await repo();
  await mkdir(join(cwd, 'src', 'consumers'), { recursive: true });
  await writeFile(join(cwd, 'src', 'types.ts'), 'export interface WidgetRecord { version: 1; id: string; }\n', 'utf-8');
  await Promise.all(Array.from({ length: 6 }, (_, index) => writeFile(join(cwd, 'src', 'consumers', `c${index}.ts`), "import type { WidgetRecord } from '../types';\nexport const x: WidgetRecord | null = null;\n", 'utf-8')));
  const traced = await traceBlastRadius(['WidgetRecord'], cwd);
  expect(traced.ok).toBe(true);
  if (!traced.ok) return;
  expect(traced.value.get('WidgetRecord')).toHaveLength(6);
  const context = await buildBlastRadiusContext('diff --git a/src/types.ts b/src/types.ts\n--- a/src/types.ts\n+++ b/src/types.ts\n@@\n+export interface WidgetRecord { version: 1; id: string; }', cwd);
  expect(context.ok).toBe(true);
  if (!context.ok) return;
  expect(context.value).toContain('Blast radius review:');
  expect(context.value).toContain('Change safety manifest:');
  expect(context.value).toContain('HIGH risk persisted type WidgetRecord changed');
});

test('returns TRANSPORT_ERROR when blast radius scan root is missing', async () => {
  const cwd = join(await repo(), 'missing');
  const traced = await traceBlastRadius(['WidgetRecord'], cwd);
  expect(traced.ok).toBe(false);
  if (traced.ok) return;
  expect(traced.error.code).toBe('TRANSPORT_ERROR');
});
