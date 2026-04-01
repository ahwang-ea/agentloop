// core/notifier.ts — Console/Slack notifier with persisted idempotency keys.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { IncomingWebhook } from '@slack/webhook';
import { dirname, join } from 'node:path';
import { ok, err, type Result } from '../shared/result.js';
import { asObjectArray, asString, parseJson, unwrapVersioned } from './persisted-json.js';
import { clearStaleLock } from './stale-lock.js';
import type { AgentloopConfig, Notification, NotifierAdapter } from '../types/index.js';

type NotificationKey = { key: string; createdAt?: string };
type NotificationState = { entries: NotificationKey[]; legacy: boolean };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const notificationStatePath = (c: Pick<AgentloopConfig, 'repoPath'>) => join(c.repoPath, '.agentloop', 'notifications.json');

async function withLock<T>(path: string, run: () => Promise<Result<T>>): Promise<Result<T>> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const stale = await clearStaleLock(lock); if (!stale.ok) return stale;
  for (let i = 0; i < 100; i++) {
    try { await mkdir(lock); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return err('TRANSPORT_ERROR', `Cannot lock ${path}`);
      if (i === 99) return err('SESSION_ERROR', `Timed out waiting for notifier lock ${lock}`);
      await sleep(50);
    }
  }
  try { return await run(); } finally { await rm(lock, { recursive: true, force: true }); }
}
async function load(path: string): Promise<Result<NotificationState>> {
  try {
    const parsed = parseJson(await readFile(path, 'utf-8'), path); if (!parsed.ok) return parsed;
    const raw = unwrapVersioned(parsed.value, 'entries');
    if (!Array.isArray(raw)) return err('TRANSPORT_ERROR', `Malformed notifier state ${path}`);
    const legacy = raw.some(item => typeof item === 'string');
    if (legacy) return ok({ legacy: true, entries: raw.filter((item): item is string => typeof item === 'string').map(key => ({ key })) });
    const entries = asObjectArray(raw);
    if (!entries) return err('TRANSPORT_ERROR', `Malformed notifier state ${path}`);
    const next: NotificationKey[] = [];
    for (const entry of entries) {
      const key = asString(entry.key), createdAt = entry.createdAt == null ? undefined : asString(entry.createdAt);
      if (!key || (entry.createdAt != null && !createdAt)) return err('TRANSPORT_ERROR', `Malformed notifier state ${path}`);
      next.push({ key, createdAt });
    }
    return ok({ legacy: false, entries: next });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? ok({ entries: [], legacy: false }) : err('TRANSPORT_ERROR', `Cannot read notifier state ${path}`);
  }
}
async function save(path: string, keys: NotificationKey[]): Promise<Result<void>> {
  try {
    await mkdir(dirname(path), { recursive: true });
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

export async function pruneNotificationKeys(config: Pick<AgentloopConfig, 'repoPath'>, now = Date.now()): Promise<Result<void>> {
  const path = notificationStatePath(config);
  return withLock(path, async () => {
    const state = await load(path); if (!state.ok) return state;
    if (state.value.legacy || state.value.entries.length === 0) return ok(undefined);
    const cutoff = now - (7 * 24 * 60 * 60 * 1000);
    const kept = state.value.entries.filter(entry => entry.createdAt == null || Date.parse(entry.createdAt) >= cutoff);
    return kept.length === state.value.entries.length ? ok(undefined) : save(path, kept);
  });
}

export function createNotifierAdapter(config: AgentloopConfig): NotifierAdapter {
  const path = notificationStatePath(config);
  const webhook = config.slackWebhookUrl ? new IncomingWebhook(config.slackWebhookUrl) : null;
  return {
    async send(notification) {
      return withLock(path, async () => {
        const state = await load(path); if (!state.ok) return state;
        if (notification.idempotencyKey && state.value.entries.some(entry => entry.key === notification.idempotencyKey)) return ok(undefined);
        const sent = await emit(webhook, notification); if (!sent.ok) return sent;
        if (!notification.idempotencyKey) return ok(undefined);
        const now = new Date().toISOString();
        const keys = state.value.entries.filter(entry => entry.key !== notification.idempotencyKey)
          .map(entry => ({ key: entry.key, createdAt: entry.createdAt ?? now }));
        keys.push({ key: notification.idempotencyKey, createdAt: now });
        return save(path, keys);
      });
    },
  };
}
