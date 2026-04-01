import { jest } from '@jest/globals';

const query = jest.fn();
await jest.unstable_mockModule('@anthropic-ai/claude-agent-sdk', () => ({ query }));
const { createClaudeAdapter } = await import('../claude.js');

const result = (text: string) => ({ type: 'result', subtype: 'success', result: text, session_id: 's-1', usage: {}, stop_reason: 'end_turn' });
const turn = (text: string) => (async function* () { yield result(text); })();
const runtime = (sleep = jest.fn(async () => undefined)) => ({
  now: () => 0,
  env: { TEST_FLAG: '1' } as NodeJS.ProcessEnv,
  sleep,
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
});

afterEach(() => {
  query.mockReset();
  jest.restoreAllMocks();
});

test('chat retries transient API-error text responses with injected runtime env', async () => {
  const sleep = jest.fn(async () => undefined);
  query.mockImplementationOnce(() => turn('API Error: Repeated 529 Overloaded errors'));
  query.mockImplementationOnce(() => turn('[]'));
  const claude = createClaudeAdapter({ repoPath: '.', claudeModel: 'claude' } as never, runtime(sleep));
  const response = await claude.chat('plan');
  expect(response).toEqual(expect.objectContaining({ ok: true }));
  if (!response.ok) return;
  expect(response.value.text).toBe('[]');
  expect(query).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledWith(1000);
  const firstCall = query.mock.calls[0][0] as { options: { env: Record<string, string> } };
  expect(firstCall.options.env.TEST_FLAG).toBe('1');
  expect(firstCall.options.env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('agentloop/0.1.0');
});
