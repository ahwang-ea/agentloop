import { buildFixPrompt, buildWritePrompt } from '../writer-prompt.js';

const task = {
  id: 'task-1',
  title: 'Define shared types',
  description: 'Create result helpers and domain types.',
  type: 'implement' as const,
  priority: 'high' as const,
  createdAt: '2026-03-31T00:00:00.000Z',
  scope: { editableFiles: ['src/types/*.ts'], readOnlyContext: ['AGENTS.md'], forbiddenFiles: ['verify.sh'] },
  acceptanceCriteria: ['Typecheck passes'],
};

test('buildFixPrompt keeps task scope, examples, and non-empty file guidance', () => {
  const prompt = buildFixPrompt(task, 'Fix the failing tests.', ['src/types/entities.ts']);
  expect(prompt).toContain('Implement this task: Define shared types');
  expect(prompt).toContain('Editable files: src/types/*.ts');
  expect(prompt).toContain('Concrete in-scope files to create or edit if missing: src/types/index.ts');
  expect(prompt).toContain('Useful in-repo examples to mirror when helpful: src/types/entities.ts');
  expect(prompt).toContain('Do not create empty source files');
  expect(prompt).toContain('Do not leave placeholder stubs');
  expect(prompt).toContain('Additional fix context:');
  expect(prompt).toContain('Fix the failing tests.');
});

test('buildWritePrompt omits example section when none are provided', () => {
  expect(buildWritePrompt(task)).not.toContain('Useful in-repo examples to mirror when helpful');
});
