import { mkdir, mkdtemp, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearStaleLock } from '../stale-lock.js';

const repo = () => mkdtemp(join(tmpdir(), 'agentloop-lock-'));

test('removes stale lock directories older than five minutes', async () => {
  const root = await repo(), lock = join(root, 'tasks.json.lock');
  await mkdir(lock, { recursive: true });
  await utimes(lock, new Date('2026-03-30T00:00:00.000Z'), new Date('2026-03-30T00:00:00.000Z'));
  const result = await clearStaleLock(lock, Date.parse('2026-03-30T00:06:00.000Z'));
  expect(result.ok).toBe(true);
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('keeps fresh lock directories in place', async () => {
  const root = await repo(), lock = join(root, 'tasks.json.lock');
  await mkdir(lock, { recursive: true });
  await utimes(lock, new Date('2026-03-30T00:00:00.000Z'), new Date('2026-03-30T00:00:00.000Z'));
  const result = await clearStaleLock(lock, Date.parse('2026-03-30T00:04:00.000Z'));
  expect(result.ok).toBe(true);
  await expect(stat(lock)).resolves.toBeTruthy();
});
