import { enqueuePlan, parsePlanJson } from '../planner.js';
import type { PlannedTask } from '../planner-types.js';

const task = (overrides: Partial<PlannedTask>): PlannedTask => ({
  planId: 'plan-1',
  title: 'Task',
  description: 'desc',
  type: 'implement',
  scope: { editableFiles: ['src/a.ts'], readOnlyContext: [], forbiddenFiles: [] },
  acceptanceCriteria: ['has tests'],
  priority: 'medium',
  ...overrides,
});

test('enqueuePlan rejects unresolved dependency mappings', async () => {
  const queue = { add: async () => ({ ok: true as const, value: { id: 'real-1' } }) };
  const result = await enqueuePlan(queue as never, [task({ planId: 'plan-2', dependsOn: ['plan-1'] })]);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.message).toContain('dependsOn references missing');
});

test('parsePlanJson adds explicit acceptance files to editable scope', () => {
  const result = parsePlanJson(JSON.stringify([task({
    scope: { editableFiles: ['src/db/*.ts'], readOnlyContext: [], forbiddenFiles: [] },
    acceptanceCriteria: ['src/db/connection.ts exports createDatabase', 'src/__tests__/db.test.ts verifies CRUD behavior'],
  })]));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value[0].scope.editableFiles).toEqual(expect.arrayContaining(['src/db/*.ts', 'src/__tests__/db.test.ts']));
});
