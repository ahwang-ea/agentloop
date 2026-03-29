#!/usr/bin/env node
// cli.ts — Entry point for agentloop.

import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { ok, err, type Result } from './shared/result.js';
import { scaffoldRepo } from './core/init.js';
import { runOrchestrator, type Deps } from './orchestrator.js';
import { createDeps } from './core/deps.js';
import type { AgentloopConfig } from './types/index.js';

const DEFAULT_CONFIG: AgentloopConfig = {
  repoPath: '.',
  baseBranch: 'main',
  verifyCommand: './verify.sh',
  agentsMdPath: 'AGENTS.md',
  architectureMdPath: 'ARCHITECTURE.md',
  claudeModel: 'claude-opus-4-6',
  codexModel: 'gpt-4.1',
  codexEnabled: true,
  convergence: { maxWallClock: 1800, maxTokens: 500000, stuckThreshold: 3, thrashOverlapRatio: 0.5 },
  taskSource: 'file',
  taskFilePath: 'tasks.json',
  maxParallelAgents: 1,
  parallelVerify: true,
  sweepInterval: 10,
};
const USAGE = ['Usage: agentloop <init|start> [options]', '  init', '  start [--interactive] [--dry-run] [--config path]'].join('\n');

type Command =
  | { name: 'init' }
  | { name: 'start'; interactive: boolean; dryRun: boolean; configPath?: string };

function parseCommand(argv: string[]): Result<Command> {
  const [command, ...args] = argv;
  if (command === 'init' && args.length === 0) return ok({ name: 'init' });
  if (command === 'start') {
    const configIndex = args.indexOf('--config');
    const configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
    if (configIndex >= 0 && !configPath) return err('CONFIG_ERROR', '--config requires a path');
    return ok({ name: 'start', interactive: args.includes('--interactive'), dryRun: args.includes('--dry-run'), configPath });
  }
  return err('CONFIG_ERROR', USAGE);
}

function summarizeTask(input: string): string {
  const oneLine = input.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 72 ? oneLine : `${oneLine.slice(0, 69).trimEnd()}...`;
}

async function enqueueInteractiveTask(deps: Deps): Promise<Result<void>> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return err('CONFIG_ERROR', 'Interactive mode requires a TTY');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const description = (await rl.question('What should agentloop build? ')).trim();
    if (!description) return err('CONFIG_ERROR', 'No task provided');
    const added = await deps.queue.add({
      title: summarizeTask(description),
      description,
      scope: { editableFiles: ['**/*'], readOnlyContext: [], forbiddenFiles: [] },
      acceptanceCriteria: [],
      model: 'auto',
      priority: 'medium',
    });
    if (!added.ok) return added;
    console.log(`Queued: ${added.value.title}`);
    return ok(undefined);
  } catch (e) {
    return err('TRANSPORT_ERROR', `Interactive input failed: ${e instanceof Error ? e.message : 'unknown error'}`);
  } finally {
    rl.close();
  }
}

async function loadConfig(path?: string): Promise<Result<AgentloopConfig>> {
  if (!path) return ok(DEFAULT_CONFIG);
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8')) as Partial<AgentloopConfig> & { architectureMdPath?: string | null };
    return ok({
      ...DEFAULT_CONFIG,
      ...raw,
      architectureMdPath: raw.architectureMdPath === null ? undefined : raw.architectureMdPath ?? DEFAULT_CONFIG.architectureMdPath,
      convergence: { ...DEFAULT_CONFIG.convergence, ...raw.convergence },
    });
  } catch (e) {
    return err('CONFIG_ERROR', `Cannot load config ${path}: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
}

async function handleInit(): Promise<Result<void>> {
  const init = await scaffoldRepo(process.cwd());
  if (!init.ok) return init;
  if (init.value.created.length > 0) console.log(`Created: ${init.value.created.join(', ')}`);
  if (init.value.skipped.length > 0) console.log(`Skipped: ${init.value.skipped.join(', ')}`);
  return ok(undefined);
}

async function handleStart(interactive: boolean, dryRun: boolean, configPath?: string): Promise<Result<void>> {
  const config = await loadConfig(configPath);
  if (!config.ok) return config;
  if (dryRun) {
    console.log(JSON.stringify({ command: 'start', interactive, dryRun, config: config.value }, null, 2));
    return ok(undefined);
  }
  const deps = await createDeps(config.value, interactive);
  if (!deps.ok) return deps;
  if (interactive) {
    const queued = await enqueueInteractiveTask(deps.value);
    if (!queued.ok) return queued;
  }
  return runOrchestrator(deps.value);
}

async function runCli(argv: string[]): Promise<Result<void>> {
  const command = parseCommand(argv);
  if (!command.ok) return command;
  return command.value.name === 'init'
    ? handleInit()
    : handleStart(command.value.interactive, command.value.dryRun, command.value.configPath);
}

const result = await runCli(process.argv.slice(2));
if (!result.ok) {
  console.error(result.error.message);
  process.exitCode = 1;
}
