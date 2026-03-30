import { featureBranchName, isTypesTask, pickQueuedTask, remainingFeatureTasks } from '../feature.js';

const task = (title: string, feature?: string, editableFiles = ['src/app.ts']) => ({
  id: title,
  title,
  description: '',
  feature,
  scope: { editableFiles, readOnlyContext: [], forbiddenFiles: [] },
  acceptanceCriteria: [],
  model: 'auto' as const,
  priority: 'medium' as const,
  createdAt: '',
});

test('builds feature branch names', () => {
  expect(featureBranchName('Checkout Flow')).toBe('feature-checkout-flow');
});

test('detects type tasks and feature grouping', () => {
  expect(isTypesTask(task('Update types', 'checkout', ['src/types/domain.ts']))).toBe(true);
  const queued = pickQueuedTask([
    { status: 'queued' as const, task: task('Impl', 'checkout') },
    { status: 'queued' as const, task: task('Types', 'checkout', ['src/types/domain.ts']) },
  ]);
  expect(queued?.task.title).toBe('Types');
});

test('waits for feature types to finish before implementation tasks', () => {
  const queued = pickQueuedTask([
    { status: 'writing' as const, task: task('Checkout types', 'checkout', ['src/types/domain.ts']) },
    { status: 'queued' as const, task: task('Checkout impl', 'checkout') },
    { status: 'queued' as const, task: task('Billing types', 'billing', ['src/types/domain.ts']) },
  ]);
  expect(queued?.task.title).toBe('Billing types');
});

test('releases feature implementation once types are done', () => {
  const queued = pickQueuedTask([
    { status: 'done' as const, task: task('Checkout types', 'checkout', ['src/types/domain.ts']) },
    { status: 'queued' as const, task: task('Checkout impl', 'checkout') },
  ]);
  expect(queued?.task.title).toBe('Checkout impl');
});

test('finds remaining feature tasks', () => {
  const tasks = [
    { status: 'done' as const, task: task('A', 'checkout'), round: 0, startedAt: '' },
    { status: 'queued' as const, task: task('B', 'checkout'), round: 0, startedAt: '' },
    { status: 'done' as const, task: task('C'), round: 0, startedAt: '' },
  ];
  expect(remainingFeatureTasks(tasks, 'checkout', 'A')).toHaveLength(1);
});
