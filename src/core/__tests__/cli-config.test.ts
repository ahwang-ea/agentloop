import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../cli-config.js';

test('loadConfig rejects invalid field types', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'agentloop-config-')), 'agentloop.json');
  await writeFile(path, JSON.stringify({ maxParallelAgents: 'two' }), 'utf-8');
  const loaded = await loadConfig(path);
  expect(loaded.ok).toBe(false);
  if (loaded.ok) return;
  expect(loaded.error.code).toBe('CONFIG_ERROR');
});

test('loadConfig accepts null architectureMdPath and merges convergence', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'agentloop-config-')), 'agentloop.json');
  await writeFile(path, JSON.stringify({ architectureMdPath: null, convergence: { maxWallClock: 42 } }), 'utf-8');
  const loaded = await loadConfig(path);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  expect(loaded.value.architectureMdPath).toBeUndefined();
  expect(loaded.value.convergence.maxWallClock).toBe(42);
});
