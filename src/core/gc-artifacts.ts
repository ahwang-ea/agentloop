import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, FinalizationState, TaskDefinition } from '../types/index.js';
import { metricsPath } from './metrics.js';
import { notificationStatePath } from './notifier.js';

const day = 24 * 60 * 60 * 1000;
const exists = async (path: string) => stat(path).then(() => true).catch(() => false);
const msg = (error: unknown) => [(error as { stderr?: string }).stderr, (error as { stdout?: string }).stdout, error instanceof Error ? error.message : String(error)].filter(Boolean).join('\n');
const taskFilePath = (config: AgentloopConfig) => config.taskFilePath?.startsWith('/') ? config.taskFilePath : join(config.repoPath, config.taskFilePath ?? 'tasks.json');

export async function rotateMetrics(config: AgentloopConfig, now = Date.now()): Promise<Result<void>> {
  try {
    const path = metricsPath(config); let info;
    try { info = await stat(path); } catch { return ok(undefined); }
    if (now - info.mtimeMs < 90 * day) return ok(undefined);
    const dir = join(config.repoPath, '.agentloop', 'metrics-archive'), base = `metrics-${new Date(info.mtimeMs).toISOString().slice(0, 10)}`;
    let archive = join(dir, `${base}.jsonl`), suffix = 1;
    while (await exists(archive)) archive = join(dir, `${base}-${suffix++}.jsonl`);
    await mkdir(dir, { recursive: true });
    await rename(path, archive);
    await writeFile(path, '', 'utf-8');
    return ok(undefined);
  } catch (error) { return err('TRANSPORT_ERROR', msg(error)); }
}

export async function cleanupFiles(config: AgentloopConfig, now = Date.now()): Promise<Result<void>> {
  try {
    const notifications = notificationStatePath(config), tasks = taskFilePath(config), temp = new RegExp(`^${basename(tasks).replace('.', '\\.')}\\..+\\.tmp$`);
    for (const dir of [dirname(notifications), dirname(tasks)]) for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name), age = await stat(path).then(info => now - info.mtimeMs).catch(() => 0);
      if (entry.isDirectory() && entry.name.endsWith('.lock') && age > 5 * 60 * 1000) await rm(path, { recursive: true, force: true });
      if (entry.isFile() && (entry.name === 'notifications.json.tmp' || temp.test(entry.name))) await rm(path, { force: true });
    }
    const agents = await exists(join(config.repoPath, config.agentsMdPath));
    const architecture = config.architectureMdPath ? await exists(join(config.repoPath, config.architectureMdPath)) : true;
    if (agents && architecture) {
      await rm(join(config.repoPath, '.agentloop', 'drafts'), { recursive: true, force: true });
      await rm(join(config.repoPath, '.agentloop', 'init-questions.json'), { force: true });
      await rm(join(config.repoPath, '.agentloop', 'coverage.json'), { force: true });
    }
    return ok(undefined);
  } catch (error) { return err('TRANSPORT_ERROR', msg(error)); }
}

export async function archiveResearch(config: AgentloopConfig, task: TaskDefinition, fin: FinalizationState): Promise<Result<void>> {
  if (!task.feature || !fin.featureMerged) return ok(undefined);
  try {
    const feature = task.feature.toLowerCase().replace(/[^a-z0-9]+/g, ''), dir = join(config.repoPath, '.agentloop', 'research');
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []), archive = join(config.repoPath, '.agentloop', 'archive');
    await mkdir(archive, { recursive: true });
    for (const entry of entries.filter(item => item.isFile() && item.name.endsWith('.md'))) {
      if (!entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '').includes(feature)) continue;
      await rename(join(dir, entry.name), join(archive, entry.name)).catch(() => rm(join(dir, entry.name), { force: true }));
    }
    return ok(undefined);
  } catch (error) { return err('TRANSPORT_ERROR', msg(error)); }
}
