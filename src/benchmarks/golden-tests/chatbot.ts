export const chatbotGoldenTest = `
import request from 'supertest';
import { jest } from '@jest/globals';

const reply = 'Golden mock reply';
let mode: 'ok' | 'error' = 'ok';
const create = jest.fn(async (payload: any) => {
  if (mode === 'error') throw new Error('mocked openai failure');
  if (payload?.stream) {
    return (async function* () {
      for (const chunk of ['Golden ', 'mock ', 'reply']) {
        yield { choices: [{ delta: { content: chunk } }], type: 'response.output_text.delta', delta: chunk };
      }
    })();
  }
  return { choices: [{ message: { content: reply } }], output_text: reply, output: [{ content: [{ type: 'output_text', text: reply }] }] };
});
class OpenAI {
  chat = { completions: { create } };
  responses = { create };
}
await jest.unstable_mockModule('openai', () => ({ default: OpenAI, OpenAI }));

const env = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  SYSTEM_PROMPT: process.env.SYSTEM_PROMPT,
  OPENAI_SYSTEM_PROMPT: process.env.OPENAI_SYSTEM_PROMPT,
  CHAT_SYSTEM_PROMPT: process.env.CHAT_SYSTEM_PROMPT,
};
const loadApp = async () => (await import('../app.js')).default;
const parseText = (res: any, done: (err: Error | null, body?: string) => void) => {
  let text = '';
  res.setEncoding('utf8');
  res.on('data', (chunk: string) => { text += chunk; });
  res.on('end', () => done(null, text));
  res.on('error', done);
};
const lastPayload = () => create.mock.calls.at(-1)?.[0] ?? {};

beforeEach(() => {
  jest.resetModules();
  create.mockClear();
  mode = 'ok';
  process.env.OPENAI_API_KEY = 'test-key';
  delete process.env.SYSTEM_PROMPT;
  delete process.env.OPENAI_SYSTEM_PROMPT;
  delete process.env.CHAT_SYSTEM_PROMPT;
});
afterEach(() => {
  env.OPENAI_API_KEY === undefined ? delete process.env.OPENAI_API_KEY : process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
  env.SYSTEM_PROMPT === undefined ? delete process.env.SYSTEM_PROMPT : process.env.SYSTEM_PROMPT = env.SYSTEM_PROMPT;
  env.OPENAI_SYSTEM_PROMPT === undefined ? delete process.env.OPENAI_SYSTEM_PROMPT : process.env.OPENAI_SYSTEM_PROMPT = env.OPENAI_SYSTEM_PROMPT;
  env.CHAT_SYSTEM_PROMPT === undefined ? delete process.env.CHAT_SYSTEM_PROMPT : process.env.CHAT_SYSTEM_PROMPT = env.CHAT_SYSTEM_PROMPT;
  jest.restoreAllMocks();
});

describe('golden: chatbot', () => {
  test('serves a chat UI with input and send control', async () => {
    const app = await loadApp();
    const root = await request(app).get('/');
    const page = root.status === 404 ? await request(app).get('/index.html') : root;
    expect(page.status).toBeLessThan(400);
    expect(page.headers['content-type']).toMatch(/html/i);
    expect(page.text).toMatch(/message|chat/i);
    expect(page.text).toMatch(/<input|<textarea/i);
    expect(page.text).toMatch(/send/i);
  });

  test('handles a basic chat request', async () => {
    const app = await loadApp();
    const res = await request(app).post('/chat').send({ message: 'Hello there' });
    expect(res.status).toBeLessThan(500);
    expect(\`\${res.text} \${JSON.stringify(res.body)}\`).toMatch(/Golden|mock|reply/i);
    expect(create).toHaveBeenCalled();
  });

  test('streams SSE data from /chat', async () => {
    const app = await loadApp();
    const res = await request(app).post('/chat').set('Accept', 'text/event-stream').buffer(false).parse(parseText).send({ message: 'Stream please', stream: true });
    expect(res.status).toBeLessThan(500);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/i);
    expect(String(res.body)).toMatch(/data:\s*.+/i);
    expect(String(res.body)).toMatch(/Golden|mock|reply/i);
  });

  test('sends conversation context and trims history', async () => {
    const app = await loadApp();
    for (const message of ['first question', 'second question', 'third question']) await request(app).post('/chat').send({ message });
    const history = JSON.stringify(lastPayload());
    expect(create).toHaveBeenCalledTimes(3);
    expect(history).toContain('first question');
    expect(history).toContain('second question');
    for (let i = 0; i < 25; i += 1) await request(app).post('/chat').send({ message: \`turn-\${String(i).padStart(2, '0')}\` });
    const payload: any = lastPayload();
    const list = Array.isArray(payload.messages) ? payload.messages : Array.isArray(payload.input) ? payload.input : null;
    expect(Array.isArray(list)).toBe(true);
    expect((list ?? []).length).toBeGreaterThan(0);
    expect((list ?? []).length).toBeLessThanOrEqual(21);
    const kept = Array.from({ length: 25 }, (_, i) => \`turn-\${String(i).padStart(2, '0')}\`).filter(token => JSON.stringify(payload).includes(token));
    expect(kept).not.toContain('turn-00');
    expect(kept.at(-1)).toBe('turn-24');
  });

  test('includes a configured system prompt in the OpenAI call', async () => {
    process.env.SYSTEM_PROMPT = 'Be concise and friendly.';
    process.env.OPENAI_SYSTEM_PROMPT = process.env.SYSTEM_PROMPT;
    process.env.CHAT_SYSTEM_PROMPT = process.env.SYSTEM_PROMPT;
    const app = await loadApp();
    await request(app).post('/chat').send({ message: 'Hi' });
    expect(JSON.stringify(lastPayload())).toContain('Be concise and friendly.');
  });

  test('returns an error response instead of crashing on OpenAI failure', async () => {
    mode = 'error';
    const app = await loadApp();
    const res = await request(app).post('/chat').send({ message: 'break please' });
    const body = \`\${res.text} \${JSON.stringify(res.body)}\`;
    expect(res.status >= 400 || /error|failed|unable|mocked openai failure/i.test(body)).toBe(true);
  });
});
`;
