import type { TaskDefinition } from '../types/index.js';

export const cleanupPrompt = 'Do a final cleanup pass. Remove obvious dead code or debug leftovers, keep behavior unchanged, and stop when done.';
export const buildWritePrompt = (task: TaskDefinition) => [
  `Implement this task: ${task.title}`,
  task.description,
  'Acceptance criteria:',
  ...task.acceptanceCriteria.map(item => `- ${item}`),
  `Editable files: ${task.scope.editableFiles.join(', ') || '(none specified)'}`,
  `Read-only context: ${task.scope.readOnlyContext.join(', ') || '(none)'}`,
  `Forbidden files: ${task.scope.forbiddenFiles.join(', ') || '(none)'}`,
  'Keep edits minimal, follow AGENTS.md, and stop when the task is complete.',
].join('\n');
