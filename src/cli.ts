#!/usr/bin/env node
// cli.ts — Entry point for agentloop.

import { readFile } from 'node:fs/promises';
import { ok, err, type Result } from './shared/result.js';
import { approveFeatureGate } from './core/approval.js';
import { loadConfig } from './core/cli-config.js';
import { scaffoldRepo } from './core/init.js';
import { formatMetricsSummary, readMetricsSummary } from './core/metrics-report.js';
import { runRescan } from './core/rescan.js';
import { formatStatusSummary, readStatusSummary } from './core/status.js';
import { runOrchestrator, type Deps } from './orchestrator.js';
import { createDeps } from './core/deps.js';
import { enqueueInteractiveTask } from './core/interactive-task.js';
const USAGE = ['Usage: agentloop <init|start|status|metrics|rescan|approve> [options]', '  init', '  start [--interactive] [--dry-run] [--config path]', '  status [--config path]', '  metrics [--config path]', '  rescan [--config path]', '  approve <task-id> [--config path]'].join('\n');

type Command =
  | { name: 'init' }
  | { name: 'start'; interactive: boolean; dryRun: boolean; configPath?: string }
  | { name: 'status'; configPath?: string }
  | { name: 'metrics'; configPath?: string }
  | { name: 'rescan'; configPath?: string }
  | { name: 'approve'; taskId: string; configPath?: string };

const configPathOf = (args: string[]) => {
  const index = args.indexOf('--config'), value = index >= 0 ? args[index + 1] : undefined;
  return index >= 0 && !value ? err('CONFIG_ERROR', '--config requires a path') : ok(value);
};

function parseCommand(argv: string[]): Result<Command> {
  const [command, ...args] = argv;
  if (command === 'init' && args.length === 0) return ok({ name: 'init' });
  if (command === 'start') {
    const configPath = configPathOf(args); if (!configPath.ok) return configPath;
    return ok({ name: 'start', interactive: args.includes('--interactive'), dryRun: args.includes('--dry-run'), configPath: configPath.value });
  }
  if (command === 'status') {
    const configPath = configPathOf(args); return configPath.ok ? ok({ name: 'status', configPath: configPath.value }) : configPath;
  }
  if (command === 'metrics') {
    const configPath = configPathOf(args); return configPath.ok ? ok({ name: 'metrics', configPath: configPath.value }) : configPath;
  }
  if (command === 'rescan') {
    const configPath = configPathOf(args); return configPath.ok ? ok({ name: 'rescan', configPath: configPath.value }) : configPath;
  }
  if (command === 'approve') {
    const taskId = args.find(arg => !arg.startsWith('--'));
    const configPath = configPathOf(args); if (!configPath.ok) return configPath;
    return taskId ? ok({ name: 'approve', taskId, configPath: configPath.value }) : err('CONFIG_ERROR', 'approve requires a task id');
  }
  return err('CONFIG_ERROR', USAGE);
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

async function handleStatus(configPath?: string): Promise<Result<void>> {
  const config = await loadConfig(configPath);
  if (!config.ok) return config;
  const summary = await readStatusSummary(config.value);
  if (!summary.ok) return summary;
  console.log(formatStatusSummary(summary.value));
  return ok(undefined);
}

async function handleMetrics(configPath?: string): Promise<Result<void>> {
  const config = await loadConfig(configPath);
  if (!config.ok) return config;
  const summary = await readMetricsSummary(config.value);
  if (!summary.ok) return summary;
  console.log(formatMetricsSummary(summary.value));
  return ok(undefined);
}

async function handleRescan(configPath?: string): Promise<Result<void>> {
  const config = await loadConfig(configPath);
  if (!config.ok) return config;
  const rescanned = await runRescan(config.value.repoPath);
  if (!rescanned.ok) return rescanned;
  console.log(rescanned.value);
  return ok(undefined);
}

async function handleApprove(taskId: string, configPath?: string): Promise<Result<void>> {
  const config = await loadConfig(configPath);
  if (!config.ok) return config;
  const approved = await approveFeatureGate(config.value, taskId);
  if (!approved.ok) return approved;
  return ok(undefined);
}

async function runCli(argv: string[]): Promise<Result<void>> {
  const command = parseCommand(argv);
  if (!command.ok) return command;
  if (command.value.name === 'init') return handleInit();
  if (command.value.name === 'status') return handleStatus(command.value.configPath);
  if (command.value.name === 'metrics') return handleMetrics(command.value.configPath);
  if (command.value.name === 'rescan') return handleRescan(command.value.configPath);
  if (command.value.name === 'approve') return handleApprove(command.value.taskId, command.value.configPath);
  return handleStart(command.value.interactive, command.value.dryRun, command.value.configPath);
}

const result = await runCli(process.argv.slice(2));
if (!result.ok) {
  console.error(result.error.message);
  process.exitCode = 1;
}
