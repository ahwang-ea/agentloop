import type { TaskState } from '../../types/index.js';
import { runScenario } from './e2e-mocks.js';

const state = (tasks: TaskState[]) => tasks[0];
const valueOf = async (mode: 'happy' | 'stuck' | 'debug') => {
  const run = await runScenario(mode);
  expect(run.ok).toBe(true);
  expect(run.ok && run.value.result.ok).toBe(true);
  return run.ok && run.value.result.ok ? run.value : undefined;
};

test('runs the full happy-path sequence to done', async () => {
  const run = await valueOf('happy');
  if (!run) return;
  expect(state(run.tasks)?.status).toBe('done');
  expect(run.events.slice(0, 2)).toEqual(['write', 'verify']);
  expect([...run.events.slice(2, 4)].sort()).toEqual(['claude-review', 'codex-review']);
  expect(run.events.slice(4)).toEqual(['cleanup', 'verify', 'verify', 'merge']);
  expect(run.metrics).toContain('"outcome":"merged"');
  expect(run.metrics).toContain('src/greet.ts');
});

test('escalates repeated verify failures into stuck', async () => {
  const run = await valueOf('stuck');
  if (!run) return;
  expect(state(run.tasks)?.status).toBe('stuck');
  expect(state(run.tasks)?.stuckReason).toContain('Same errors 2 rounds');
  expect(run.events).toEqual(['write', 'verify', 'fix', 'verify']);
  expect(run.metrics).toContain('"outcome":"stuck"');
});

test('blocks debug tasks immediately for human approval', async () => {
  const run = await valueOf('debug');
  if (!run) return;
  expect(state(run.tasks)?.status).toBe('blocked');
  expect(state(run.tasks)?.blocked?.details.kind).toBe('needs-human');
  expect(run.events).toEqual([]);
  expect(run.metrics).toContain('"outcome":"needs-human"');
});
