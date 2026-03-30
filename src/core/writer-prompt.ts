import type { TaskDefinition } from '../types/index.js';

export const cleanupPrompt = 'Do a final cleanup pass. Remove obvious dead code or debug leftovers, keep behavior unchanged, and stop when done.';

const researchPrompt = (task: TaskDefinition) => [
  `Research this task: ${task.title}`,
  task.description,
  'Produce only research artifacts:',
  '- An interface-only adapter file under src/adapters/',
  '- Research notes under .agentloop/research/',
  '- A one-line decision row added to ARCHITECTURE.md',
  'Use web search when repo context is insufficient. Do not implement production behavior beyond interfaces and notes.',
];

export const buildWritePrompt = (task: TaskDefinition) => [
  ...(task.type === 'research' ? researchPrompt(task) : [`Implement this task: ${task.title}`, task.description]),
  'Acceptance criteria:',
  ...task.acceptanceCriteria.map(item => `- ${item}`),
  `Editable files: ${task.scope.editableFiles.join(', ') || '(none specified)'}`,
  `Read-only context: ${task.scope.readOnlyContext.join(', ') || '(none)'}`,
  `Forbidden files: ${task.scope.forbiddenFiles.join(', ') || '(none)'}`,
  'Keep edits minimal, follow AGENTS.md, and stop when the task is complete.',
].join('\n');
