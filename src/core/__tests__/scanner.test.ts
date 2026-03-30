import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeInventory } from '../scanner.js';

test('writes repo inventory with patterns, tests, and env mismatches', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'agentloop-scan-'));
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { jest: '^1.0.0' } }), 'utf-8');
  await writeFile(join(repo, '.env.example'), 'API_KEY=1\nUNUSED=1\n', 'utf-8');
  await writeFile(join(repo, 'src', 'orders.service.ts'), 'import { helper } from "./helper";\nconst x: Result<string> = ok("x");\nprocess.env.API_KEY;\n', 'utf-8');
  await writeFile(join(repo, 'src', 'helper.ts'), 'export const helper = 1;\n', 'utf-8');
  await writeFile(join(repo, 'src', 'orders.test.ts'), 'test("x", () => expect(true).toBe(true));\n', 'utf-8');
  const result = await writeInventory(repo);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const written = JSON.parse(await readFile(join(repo, '.agentloop', 'inventory.json'), 'utf-8')) as typeof result.value;
  expect(written.tests.count).toBe(1);
  expect(written.tests.frameworks).toContain('jest');
  expect(written.patterns.serviceFileCount).toBe(1);
  expect(written.importFrequency[0]?.path).toBe('src/helper.ts');
  expect(written.env.unusedInExample).toContain('UNUSED');
});
