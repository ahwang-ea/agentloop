import type { BenchmarkSuite } from '../types.js';
import { teamAssistantGoldenTest } from '../golden-tests/team-assistant.js';

export const teamAssistantSuite: BenchmarkSuite = {
  name: 'Team CLI assistant',
  goal: [
    'Build a TypeScript interactive CLI assistant for small teams. The CLI entrypoint must be src/index.ts.',
    'Features: a natural-language REPL, a task/todo system stored in local SQLite, a daily standup generator',
    'from task history, a searchable decision log, and meeting note summarization that uses the OpenAI API to',
    'extract action items. Use commander, better-sqlite3, inquirer, and the openai SDK. Include mocked tests.',
  ].join(' '),
  maxTimeSec: 2400,
  baseDeps: ['commander', 'inquirer', '@types/inquirer', 'better-sqlite3', '@types/better-sqlite3', 'openai'],
  goldenTestFile: teamAssistantGoldenTest,
  acceptanceTests: [
    { type: 'command', name: 'compiles', cmd: 'npm', args: ['run', 'typecheck'] },
    { type: 'command', name: 'tests pass', cmd: 'npm', args: ['test'] },
    { type: 'file-contains-regex', name: 'has CLI commands', dir: 'src', extensions: ['.ts'], regex: '\\.command\\(' },
    { type: 'file-contains-substring', name: 'has db schema', dir: 'src', extensions: ['.ts'], substring: 'CREATE TABLE' },
    { type: 'file-contains-regex', name: 'has task CRUD', dir: 'src', extensions: ['.ts'], regex: 'addTask|completeTask|listTasks' },
    { type: 'file-contains-regex', name: 'has decision log', dir: 'src', extensions: ['.ts'], regex: '[Dd]ecision[A-Z]|create_decision|decision_log' },
    { type: 'file-contains-regex', name: 'has summarizer', dir: 'src', extensions: ['.ts'], regex: 'openai|OpenAI|summarize' },
    { type: 'command', name: 'builds to dist', cmd: 'npm', args: ['run', 'build'] },
    { type: 'file-exists', name: 'has CLI entrypoint', paths: ['dist/index.js', 'dist/cli.js', 'dist/main.js'] },
  ],
};
