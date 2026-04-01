import type { TaskDefinition } from '../types/index.js';

export const cleanupPrompt = 'Do a final cleanup pass. Remove obvious dead code or debug leftovers, keep behavior unchanged, and stop when done.';
const filePattern = /(?:^|[\s('"`])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)(?=$|[\s)'"`,:;])/g;
const uniq = (items: string[]) => [...new Set(items.filter(Boolean))];
const acceptanceFiles = (task: TaskDefinition) => uniq(task.acceptanceCriteria.flatMap(item => [...item.matchAll(filePattern)].map(([, path]) => path)));
const concreteTarget = (pattern: string) => {
  if (!pattern.includes('*')) return pattern;
  const extension = pattern.match(/\.[A-Za-z0-9]+$/)?.[0] ?? '.ts';
  const base = pattern.replace(/\/\*\*\/?/g, '/').replace(/\/\*[^/]*$/g, '');
  return base === pattern ? pattern : `${base}/index${extension}`.replace(/\/+/g, '/');
};
const exampleLine = (examples: string[]) => examples.length === 0 ? [] : [`Useful in-repo examples to mirror when helpful: ${examples.join(', ')}`];

export const concreteTargetsOf = (task: TaskDefinition) => uniq([...acceptanceFiles(task), ...task.scope.editableFiles.map(concreteTarget)]).slice(0, 5);
const researchPrompt = (task: TaskDefinition) => [
  `Research this task: ${task.title}`,
  task.description,
  'Read ARCHITECTURE.md before deciding on interfaces or packages.',
  'Produce only research artifacts:',
  '- An interface-only adapter file under src/adapters/',
  '- Research notes under .agentloop/research/',
  '- A one-line decision row added to ARCHITECTURE.md',
  'Use web search when repo context is insufficient. Do not implement production behavior beyond interfaces and notes.',
];

export const buildCleanupPrompt = (task: Pick<TaskDefinition, 'scope'>) => [
  cleanupPrompt,
  `Editable files: ${task.scope.editableFiles.join(', ') || '(none specified)'}`,
  'Do not inspect or edit node_modules, dist, coverage, .git, or generated files. Stop immediately if no cleanup is needed.',
].join('\n');
export const buildWritePrompt = (task: TaskDefinition, examples: string[] = []) => [
  ...(task.type === 'research' ? researchPrompt(task) : [`Implement this task: ${task.title}`, task.description]),
  'Acceptance criteria:',
  ...task.acceptanceCriteria.map(item => `- ${item}`),
  `Editable files: ${task.scope.editableFiles.join(', ') || '(none specified)'}`,
  ...(concreteTargetsOf(task).length === 0 ? [] : [`Concrete in-scope files to create or edit if missing: ${concreteTargetsOf(task).join(', ')}`]),
  `Read-only context: ${task.scope.readOnlyContext.join(', ') || '(none)'}`,
  ...exampleLine(examples),
  `Forbidden files: ${task.scope.forbiddenFiles.join(', ') || '(none)'}`,
  'Prefer the names and shapes already present in read-only context; do not invent aliases unless the task explicitly requires a mapping layer.',
  'Respect optional vs required fields from read-only context; do not invent new invariants or validation rules unless the task or acceptance criteria require them.',
  'Do not generate ids or timestamps inside business logic unless the task explicitly asks for it; prefer ids from input and injected clocks.',
  'Do not invent repository, store, or *Db abstractions unless the task explicitly asks for them; prefer existing db helpers, row mappers, and Result types from read-only context.',
  'Do not import or add new npm packages unless the task explicitly requires them and package.json is editable; prefer built-in Node APIs or local helpers.',
  'If an editable path is a glob or a missing file, create matching in-scope directories and files yourself before stopping.',
  'Do not create empty source files; every created code file must contain real exports, logic, or tests.',
  'Do not leave placeholder stubs, placeholder error returns, or empty test files; if you create a test file, include at least one real test.',
  'Keep edits minimal, follow AGENTS.md, and stop when the task is complete.',
  'Before stopping, make at least one real in-scope file edit or create a required in-scope file. Do not reply with only analysis or a plan.',
].join('\n');
export const buildFixPrompt = (task: TaskDefinition, prompt: string, examples: string[] = []) => [
  buildWritePrompt(task, examples),
  '',
  'Additional fix context:',
  prompt,
].join('\n');
