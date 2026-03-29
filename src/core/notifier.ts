// core/notifier.ts — Console/Slack notifier with persisted idempotency keys.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { IncomingWebhook } from '@slack/webhook';
import { dirname, join } from 'node:path';
import { ok, err, type Result } from '../shared/result.js';
import type { AgentloopConfig, Notification, NotifierAdapter } from '../types/index.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const statePath = (c: AgentloopConfig) => join(c.repoPath, '.agentloop', 'notifications.json');
async function withLock<T>(path: string, run: () => Promise<Result<T>>): Promise<Result<T>> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  for (let i = 0; i < 100; i++) {
    try { await mkdir(lock); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return err('TRANSPORT_ERROR', `Cannot lock ${path}`);
      if (i === 99) return err('SESSION_ERROR', `Timed out waiting for notifier lock ${lock}`);
      await sleep(50);
    }
  }
  try { return await run(); } finally { await rm(lock, { recursive: true, force: true }); }
}
async function load(path: string): Promise<Result<string[]>> {
  try { return ok(JSON.parse(await readFile(path, 'utf-8')) as string[]); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? ok([]) : e instanceof SyntaxError ? err('TRANSPORT_ERROR', `Malformed notifier state ${path}`) : err('TRANSPORT_ERROR', `Cannot read notifier state ${path}`);
  }
}
async function save(path: string, keys: string[]): Promise<Result<void>> {
  try {
    await mkdir(join(path, '..'), { recursive: true });
    const temp = `${path}.tmp`;
    await writeFile(temp, JSON.stringify(keys, null, 2));
    await rename(temp, path);
    return ok(undefined);
  } catch { return err('TRANSPORT_ERROR', `Cannot write notifier state ${path}`); }
}
async function emit(webhook: IncomingWebhook | null, notification: Notification): Promise<Result<void>> {
  const text = `[${notification.type}] ${notification.summary}\n${notification.details}`;
  try { webhook ? await webhook.send({ text }) : console.log(text); return ok(undefined); }
  catch (e) { return err('NOTIFY_FAILED', e instanceof Error ? e.message : String(e)); }
}

export function createNotifierAdapter(config: AgentloopConfig): NotifierAdapter {
  const path = statePath(config);
  const webhook = config.slackWebhookUrl ? new IncomingWebhook(config.slackWebhookUrl) : null;
  return {
    async send(notification) {
      return withLock(path, async () => {
        const keys = await load(path); if (!keys.ok) return keys;
        if (notification.idempotencyKey && keys.value.includes(notification.idempotencyKey)) return ok(undefined);
        const sent = await emit(webhook, notification); if (!sent.ok) return sent;
        if (!notification.idempotencyKey) return ok(undefined);
        keys.value.push(notification.idempotencyKey);
        return save(path, keys.value);
      });
    },
  };
}
