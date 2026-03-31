import { jest } from '@jest/globals';

const query = jest.fn();
await jest.unstable_mockModule('@anthropic-ai/claude-agent-sdk', () => ({ query }));
const { createClaudeAdapter } = await import('../claude.js');

const result = (text: string) => ({ type: 'result', subtype: 'success', result: text, session_id: 's-1', usage: {}, stop_reason: 'end_turn' });
const turn = (text: string) => (async function* () { yield result(text); })();

test('chat retries transient API-error text responses', async () => {
  query.mockReset();
  query.mockImplementationOnce(() => turn('API Error: Repeated 529 Overloaded errors'));
  query.mockImplementationOnce(() => turn('[]'));
  const claude = createClaudeAdapter({ repoPath: '.', claudeModel: 'claude' } as never);
  const response = await claude.chat('plan');
  expect(response).toEqual(expect.objectContaining({ ok: true }));
  if (!response.ok) return;
  expect(response.value.text).toBe('[]');
  expect(query).toHaveBeenCalledTimes(2);
});
