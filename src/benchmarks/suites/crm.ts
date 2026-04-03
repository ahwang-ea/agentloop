import type { BenchmarkSuite } from '../types.js';
import { crmGoldenTest } from '../golden-tests/crm.js';

const crmGoal = [
  'Build a TypeScript REST API for a simple CRM with contacts, deals, notes, and a search endpoint.',
  'Use Express for HTTP, SQLite via better-sqlite3 for storage, and zod for input validation.',
  'Canonical entity shapes are: Contact { id, firstName, lastName, email, phone?, createdAt, updatedAt },',
  'Deal { id, contactId, title, value, status, createdAt, updatedAt }, and',
  'Note { id, contactId?, dealId?, content, createdAt, updatedAt }.',
  'Because contactId and dealId are optional, a note may reference a contact, a deal, both, or neither unless a task explicitly says otherwise.',
  'Include CRUD endpoints for all entities, proper error handling, and tests.',
].join(' ');

const crmArchitecture = [
  '- Contact fields: id, firstName, lastName, email, phone?, createdAt, updatedAt.',
  '- Deal fields: id, contactId, title, value, status, createdAt, updatedAt.',
  '- Note fields: id, contactId?, dealId?, content, createdAt, updatedAt.',
  '- A note may have contactId, dealId, both, or neither; do not add a required relationship unless a task explicitly asks for one.',
  '- Expose CRUD routes directly at /contacts, /deals, and /notes.',
  '- Deals must reference real contacts; enforce that foreign-key rule in the API behavior.',
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
  ],
};
