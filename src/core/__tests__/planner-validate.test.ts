import { validatePlan } from '../planner-validate.js';
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

test('rejects forward dependencies', () => {
  const issues = validatePlan([
    task({ planId: 'plan-1', dependsOn: ['plan-2'] }),
    task({ planId: 'plan-2', scope: { editableFiles: ['src/a.ts'], readOnlyContext: [], forbiddenFiles: [] } }),
  ]);
  expect(issues).toContain('[plan-1] dependsOn must reference earlier task plan-2');
});

test('rejects feature groups that put types after implementation', () => {
  const issues = validatePlan([
    task({ planId: 'plan-1', feature: 'billing', title: 'Implement billing flow', scope: { editableFiles: ['src/billing.ts'], readOnlyContext: [], forbiddenFiles: [] } }),
    task({ planId: 'plan-2', feature: 'billing', title: 'Define billing types', scope: { editableFiles: ['src/types/billing.ts'], readOnlyContext: [], forbiddenFiles: [] } }),
  ]);
  expect(issues).toContain('[billing] types-first ordering violated by plan-2');
});


test('rejects acceptance file paths outside editable scope', () => {
  const issues = validatePlan([
    task({
      planId: 'plan-test',
      scope: { editableFiles: ['src/db/*.ts'], readOnlyContext: [], forbiddenFiles: [] },
      acceptanceCriteria: ['src/__tests__/db.test.ts verifies CRUD behavior'],
    }),
  ]);
  expect(issues).toContain('[plan-test] acceptance criteria references src/__tests__/db.test.ts outside scope');
});
