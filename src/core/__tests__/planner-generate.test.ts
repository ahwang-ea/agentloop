import { jest } from '@jest/globals';
import { ok } from '../../shared/result.js';

const readRepoFile = jest.fn(async () => ok(''));
const scanRepo = jest.fn(async () => ok({ files: [] } as never));

await jest.unstable_mockModule('../repo-file.js', () => ({ readRepoFile }));
await jest.unstable_mockModule('../scanner.js', () => ({ scanRepo }));
const { generatePlan } = await import('../planner.js');

const taskJson = JSON.stringify([{
  planId: 'p1',
  title: 'Define types',
  description: 'Create shared types.',
  type: 'implement',
  priority: 'medium',
  scope: { editableFiles: ['src/types/*.ts'], readOnlyContext: ['AGENTS.md'], forbiddenFiles: [] },
  acceptanceCriteria: ['Typecheck passes'],
  dependsOn: [],
}]);

const invalidTaskJson = JSON.stringify([{
  planId: 'p1',
  title: 'Define types',
  description: 'Create shared types.',
  type: 'implement',
  priority: 'medium',
  scope: { editableFiles: [], readOnlyContext: ['AGENTS.md'], forbiddenFiles: [] },
  acceptanceCriteria: ['Typecheck passes'],
  dependsOn: [],
}]);

afterEach(() => {
  jest.restoreAllMocks();
  readRepoFile.mockReset();
  readRepoFile.mockResolvedValue(ok(''));
  scanRepo.mockReset();
  scanRepo.mockResolvedValue(ok({ files: [] } as never));
});

test('retries compact-first when the planner first returns non-JSON text', async () => {
  const chat = jest.fn().mockResolvedValueOnce(ok({ text: 'Sure — here is the plan.' }) as never).mockResolvedValueOnce(ok({ text: taskJson }) as never);
  const claude = { chat } as never;
  const result = await generatePlan({ claude, queue: {} as never, config: { repoPath: '.', agentsMdPath: 'AGENTS.md', architectureMdPath: 'ARCHITECTURE.md' } } as never, 'goal');
  expect(result.ok).toBe(true);
  expect(chat).toHaveBeenCalledTimes(2);
  expect(readRepoFile).not.toHaveBeenCalled();
  expect(chat.mock.calls[0][0]).not.toContain('AGENTS.md:');
  expect(chat.mock.calls[1][0]).not.toContain('ARCHITECTURE.md:');
});

test('loads full docs only after compact validation fails', async () => {
  readRepoFile.mockResolvedValueOnce(ok('agents rules')).mockResolvedValueOnce(ok('architecture rules'));
  const chat = jest.fn().mockResolvedValueOnce(ok({ text: invalidTaskJson }) as never).mockResolvedValueOnce(ok({ text: taskJson }) as never);
  const claude = { chat } as never;
  const result = await generatePlan({ claude, queue: {} as never, config: { repoPath: '.', agentsMdPath: 'AGENTS.md', architectureMdPath: 'ARCHITECTURE.md' } } as never, 'goal');
  expect(result.ok).toBe(true);
  expect(chat).toHaveBeenCalledTimes(2);
  expect(readRepoFile).toHaveBeenCalledTimes(2);
  expect(chat.mock.calls[0][0]).not.toContain('AGENTS.md:');
  expect(chat.mock.calls[1][0]).toContain('AGENTS.md:');
  expect(chat.mock.calls[1][0]).toContain('ARCHITECTURE.md:');
  expect(chat.mock.calls[1][0]).toContain('editableFiles must be non-empty');
});
