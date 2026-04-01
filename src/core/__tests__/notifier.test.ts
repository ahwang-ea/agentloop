import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneNotificationKeys } from '../notifier.js';

test('prunes versioned notifier state', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-notifier-'));
  await mkdir(join(repoPath, '.agentloop'), { recursive: true });
  await writeFile(join(repoPath, '.agentloop', 'notifications.json'), JSON.stringify({
    version: 1,
    entries: [
      { key: 'old', createdAt: '2026-03-01T00:00:00.000Z' },
      { key: 'fresh', createdAt: '2026-04-01T00:00:00.000Z' },
    ],
  }), 'utf-8');
  const pruned = await pruneNotificationKeys({ repoPath }, Date.parse('2026-04-07T00:00:00.000Z'));
  expect(pruned.ok).toBe(true);
  const saved = JSON.parse(await readFile(join(repoPath, '.agentloop', 'notifications.json'), 'utf-8')) as Array<{ key: string }>;
  expect(saved).toEqual([{ key: 'fresh', createdAt: '2026-04-01T00:00:00.000Z' }]);
});
