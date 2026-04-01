import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../cli-config.js';

const configPath = async (body: unknown) => {
  const path = join(await mkdtemp(join(tmpdir(), 'agentloop-config-')), 'agentloop.json');
  await writeFile(path, JSON.stringify(body), 'utf-8');
  return path;
};

test('loadConfig rejects invalid field types', async () => {
  const loaded = await loadConfig(await configPath({ maxParallelAgents: 'two' }));
  expect(loaded.ok).toBe(false);
  if (loaded.ok) return;
  expect(loaded.error.code).toBe('CONFIG_ERROR');
});

test('loadConfig rejects unsupported parallelVerify=false', async () => {
  const loaded = await loadConfig(await configPath({ parallelVerify: false }));
  expect(loaded.ok).toBe(false);
  if (loaded.ok) return;
  expect(loaded.error.message).toContain('parallelVerify cannot be false');
});

test('loadConfig rejects invalid numeric semantics', async () => {
  const loaded = await loadConfig(await configPath({ maxParallelAgents: 0, sweepInterval: -1 }));
  expect(loaded.ok).toBe(false);
  if (loaded.ok) return;
  expect(loaded.error.message).toContain('maxParallelAgents');
});

test('loadConfig requires linear credentials for linear task sources', async () => {
  const loaded = await loadConfig(await configPath({ taskSource: 'linear', linearApiKey: 'token' }));
  expect(loaded.ok).toBe(false);
  if (loaded.ok) return;
  expect(loaded.error.message).toContain('linearTeamId');
});

test('loadConfig accepts null architectureMdPath and merges convergence', async () => {
  const loaded = await loadConfig(await configPath({ architectureMdPath: null, convergence: { maxWallClock: 42 } }));
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  expect(loaded.value.architectureMdPath).toBeUndefined();
  expect(loaded.value.convergence.maxWallClock).toBe(42);
});
