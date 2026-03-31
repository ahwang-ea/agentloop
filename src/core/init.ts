// core/init.ts — Repo scaffolding for `agentloop init`.

import { access, chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, err, type Result } from '../shared/result.js';
import { writeInventory } from './scanner.js';
import { runSmartInit, shouldRunSmartInit } from './smart-init.js';

interface Summary { created: string[]; skipped: string[]; }
interface ScaffoldOptions { smartInit?: boolean; }
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const asset = (...parts: string[]) => join(root, '..', ...parts);
const exists = async (path: string) => access(path, constants.F_OK).then(() => true).catch(() => false);
const npmLocks = ['package-lock.json', 'npm-shrinkwrap.json'];
const altLocks = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

async function readTemplate(path: string, projectName: string): Promise<Result<string>> {
  try {
    const content = await readFile(path, 'utf-8');
    return ok(content.replaceAll('{{PROJECT_NAME}}', projectName));
  } catch (e) {
    return err('TRANSPORT_ERROR', `Cannot read template ${path}: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
}
async function writeOnce(path: string, content: string, summary: Summary, mode?: number): Promise<Result<void>> {
  if (await exists(path)) { summary.skipped.push(path); return ok(undefined); }
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf-8');
    if (mode != null) await chmod(path, mode);
    summary.created.push(path);
    return ok(undefined);
  } catch (e) {
    return err('TRANSPORT_ERROR', `Cannot write ${path}: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
}
async function copyOnce(from: string, to: string, summary: Summary, mode?: number): Promise<Result<void>> {
  if (await exists(to)) { summary.skipped.push(to); return ok(undefined); }
  try {
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    if (mode != null) await chmod(to, mode);
    summary.created.push(to);
    return ok(undefined);
  } catch (e) {
    return err('TRANSPORT_ERROR', `Cannot copy ${from} to ${to}: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
}
async function npmRepo(repoPath: string) {
  if (!await exists(join(repoPath, 'package.json'))) return false;
  const npmManaged = (await Promise.all(npmLocks.map(name => exists(join(repoPath, name))))).some(Boolean);
  const altManaged = (await Promise.all(altLocks.map(name => exists(join(repoPath, name))))).some(Boolean);
  return npmManaged || !altManaged;
}

export async function scaffoldRepo(repoPath: string, options: ScaffoldOptions = {}): Promise<Result<Summary>> {
  const summary: Summary = { created: [], skipped: [] };
  const projectName = basename(repoPath);
  const agents = await readTemplate(asset('templates', 'AGENTS.md'), projectName); if (!agents.ok) return agents;
  const arch = await readTemplate(asset('templates', 'ARCHITECTURE.md'), projectName); if (!arch.ok) return arch;
  const verify = await readTemplate(asset('templates', 'verify.sh'), projectName); if (!verify.ok) return verify;
  const security = await npmRepo(repoPath) ? [
    copyOnce(asset('templates', '.npmrc'), join(repoPath, '.npmrc'), summary),
    copyOnce(asset('templates', 'socket.yml'), join(repoPath, 'socket.yml'), summary),
    copyOnce(asset('templates', '.github', 'workflows', 'socket-security.yml'), join(repoPath, '.github', 'workflows', 'socket-security.yml'), summary),
  ] : [];
  const files: Array<Promise<Result<void>>> = [
    writeOnce(join(repoPath, 'AGENTS.md'), agents.value, summary),
    writeOnce(join(repoPath, 'ARCHITECTURE.md'), arch.value, summary),
    writeOnce(join(repoPath, 'verify.sh'), verify.value, summary, 0o755),
    copyOnce(asset('templates', 'CODEX_HOOKS_README.md'), join(repoPath, 'CODEX_HOOKS_README.md'), summary),
    copyOnce(asset('templates', 'tsconfig.json'), join(repoPath, 'tsconfig.json'), summary),
    copyOnce(asset('templates', 'claude-settings.json'), join(repoPath, '.claude', 'settings.json'), summary),
    copyOnce(asset('templates', 'codex-hooks.json'), join(repoPath, '.codex', 'hooks.json'), summary),
    copyOnce(asset('templates', '.claude', 'commands', 'status.md'), join(repoPath, '.claude', 'commands', 'status.md'), summary),
    copyOnce(asset('templates', '.claude', 'commands', 'queue.md'), join(repoPath, '.claude', 'commands', 'queue.md'), summary),
    copyOnce(asset('templates', '.claude', 'commands', 'add-task.md'), join(repoPath, '.claude', 'commands', 'add-task.md'), summary),
    copyOnce(asset('templates', '.claude', 'commands', 'recent.md'), join(repoPath, '.claude', 'commands', 'recent.md'), summary),
    copyOnce(asset('templates', '.claude', 'commands', 'metrics.md'), join(repoPath, '.claude', 'commands', 'metrics.md'), summary),
    copyOnce(asset('templates', '.claude', 'commands', 'approve.md'), join(repoPath, '.claude', 'commands', 'approve.md'), summary),
    copyOnce(asset('templates', '.claude', 'commands', 'review-agents-update.md'), join(repoPath, '.claude', 'commands', 'review-agents-update.md'), summary),
    copyOnce(asset('hooks', 'scope-check.py'), join(repoPath, '.agentloop', 'hooks', 'scope-check.py'), summary, 0o755),
    copyOnce(asset('hooks', 'on-stop.py'), join(repoPath, '.agentloop', 'hooks', 'on-stop.py'), summary, 0o755),
    writeOnce(join(repoPath, '.agentloop', 'current-scope.json'), JSON.stringify({ editableFiles: ['**/*'], readOnlyContext: [], forbiddenFiles: [] }, null, 2), summary),
    writeOnce(join(repoPath, '.agentloop', 'session-status.json'), JSON.stringify({ status: 'idle' }, null, 2), summary),
    ...security,
  ];
  for (const result of await Promise.all(files)) if (!result.ok) return result;
  const inventory = await writeInventory(repoPath); if (!inventory.ok) return inventory;
  if ((options.smartInit ?? true) && shouldRunSmartInit(inventory.value)) {
    const smart = await runSmartInit(repoPath);
    if (!smart.ok) return smart;
  }
  return ok(summary);
}
