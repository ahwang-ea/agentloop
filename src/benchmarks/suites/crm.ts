import type { BenchmarkSuite } from '../types.js';
import { crmGoldenTest } from '../golden-tests/crm.js';

const crmGoal = [
  'Build a TypeScript REST API for a simple CRM with contacts, deals, notes, and a search endpoint.',
  'Use Express for HTTP, SQLite via better-sqlite3 for storage, and zod for input validation.',
  'Canonical entity shapes are: Contact { id, firstName, lastName, email, phone?, createdAt, updatedAt },',
  'Deal { id, contactId, title, value, status, createdAt, updatedAt }, and',
  'Note { id, contactId?, dealId?, content, createdAt, updatedAt }.',
  'Because contactId and dealId are optional, a note may reference a contact, a deal, both, or neither unless a task explicitly says otherwise.',
  'Keep these names consistent across types, schemas, database columns, services, routes, and tests.',
  'If SQLite columns use snake_case, they must map directly to the same fields: first_name, last_name,',
  'contact_id, deal_id, created_at, updated_at, status, and content.',
  'Do not introduce alternate names like name/company, stage, or body unless a mapping layer is explicitly required.',
  'Include CRUD endpoints for all entities, proper error handling with Result types, and tests with an in-memory database.',
].join(' ');

const crmArchitecture = [
  '- Use one shared data model across all layers.',
  '- Contact fields: id, firstName, lastName, email, phone?, createdAt, updatedAt.',
  '- Deal fields: id, contactId, title, value, status, createdAt, updatedAt.',
  '- Note fields: id, contactId?, dealId?, content, createdAt, updatedAt.',
  '- A note may have contactId, dealId, both, or neither; do not add a required relationship unless a task explicitly asks for one.',
  '- SQLite columns are the snake_case equivalents of the shared fields.',
  '- Prefer status over stage, and content over body.',
  '- Services return Result<T, E> where E contains code and message.',
  '- In-memory SQLite tests should rely on behavior that works with :memory: databases; do not require WAL-only behavior from ephemeral test databases.',
  '- Tests create a fresh in-memory better-sqlite3 database per test and inject clocks instead of calling Date.now().',
  '- Expose CRUD routes directly at /contacts, /deals, and /notes; do not mount them only under /api.',
  '- Export the configured Express app as the default export from src/app.ts (do not call app.listen in that file).',
].join('\n');

export const crmSuite: BenchmarkSuite = {
  name: 'Simple CRM',
  goal: crmGoal,
  maxTimeSec: 3600,
  baseDeps: ['express', '@types/express', 'better-sqlite3', '@types/better-sqlite3', 'zod', 'supertest', '@types/supertest'],
  architectureNotes: crmArchitecture,
  goldenTestFile: crmGoldenTest,
  acceptanceTests: [
    { type: 'command', name: 'compiles', cmd: 'npm', args: ['run', 'typecheck'] },
    { type: 'command', name: 'tests pass', cmd: 'npm', args: ['test'] },
    { type: 'file-contains-regex', name: 'has route handlers', dir: 'src', extensions: ['.ts'], regex: 'router\\.(get|post|put|delete)\\(' },
    { type: 'file-contains-regex', name: 'has zod validation', dir: 'src', extensions: ['.ts'], regex: 'z\\.(object|string|number)\\(' },
    { type: 'command', name: 'golden tests pass', cmd: 'npm', args: ['test', '--', '--testPathPattern', 'golden'] },
  ],
};
