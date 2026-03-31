import type { BenchmarkSuite } from '../types.js';

export const chatbotSuite: BenchmarkSuite = {
  name: 'ChatGPT-style chat app',
  goal: [
    'Build a TypeScript chat application with a Node.js backend and a single HTML frontend.',
    'Backend: Express server with a /chat endpoint that forwards messages to the OpenAI API',
    'via the openai SDK and streams responses back via SSE. Frontend: single index.html with',
    'a message list, input box, and send button. Include conversation history management for',
    'the last 20 messages, a system prompt configurable via env var, and mocked backend tests.',
  ].join(' '),
  maxTimeSec: 2400,
  baseDeps: ['express', '@types/express', 'openai'],
  acceptanceTests: [
    { type: 'command', name: 'compiles', cmd: 'npm', args: ['run', 'typecheck'] },
    { type: 'command', name: 'tests pass', cmd: 'npm', args: ['test'] },
    { type: 'file-contains-regex', name: 'has chat endpoint', dir: 'src', extensions: ['.ts'], regex: "['\"/]chat" },
    { type: 'file-exists', name: 'has frontend', paths: ['src/public/index.html', 'public/index.html'] },
    { type: 'file-contains-regex', name: 'has SSE streaming', dir: 'src', extensions: ['.ts'], regex: 'text/event-stream|EventSource' },
  ],
};
