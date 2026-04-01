import { jest } from '@jest/globals';

let response = { choices: [{ message: { content: '{"findings":[]}' } }] };
const create = async () => response;
const OpenAI = jest.fn().mockImplementation(() => ({ chat: { completions: { create } } }));
await jest.unstable_mockModule('openai', () => ({ default: OpenAI }));
const { createCodexAdapter } = await import('../codex.js');

const task = {
  id: 't1',
  title: 'Task',
  description: 'Desc',
  acceptanceCriteria: ['works'],
  scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] },
  type: 'implement',
  priority: 'medium',
  createdAt: '',
};

afterEach(() => {
  response = { choices: [{ message: { content: '{"findings":[]}' } }] };
  OpenAI.mockClear();
});

test('uses injected runtime clock for review duration', async () => {
  const times = [1000, 2500];
  const codex = createCodexAdapter('key', 'gpt-4.1', { now: () => times.shift() ?? 2500 });
  const result = await codex.review({ role: 'codex-detail', diff: 'diff', taskDefinition: task as never, agentsMd: '# agents' });
  expect(OpenAI).toHaveBeenCalledWith({ apiKey: 'key' });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.duration).toBe(1.5);
  expect(result.value.reviewer).toBe('codex-detail');
});
