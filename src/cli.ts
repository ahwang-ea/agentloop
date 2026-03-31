#!/usr/bin/env node
// cli.ts — Entry point for agentloop.

import { err, ok, type Result } from './shared/result.js';
import {
  handleApprove,
  handleBenchmark,
  handleImprove,
  handleInit,
  handleMetrics,
  handlePlan,
  handleRescan,
  handleStart,
  handleStatus,
} from './core/cli-commands.js';
const USAGE = [
  'Usage: agentloop <init|start|status|metrics|rescan|approve|plan|benchmark|improve> [options]',
  '  init', '  start [--interactive] [--dry-run] [--config path]', '  status [--config path]', '  metrics [--config path]', '  rescan [--config path]',
  '  approve <task-id> [--config path]', '  plan <goal> | --file goal.md [--config path]', '  benchmark --suite <name|all> | --list [--config path]', '  improve [--results path] [--apply] [--config path]',
].join('\n');

type Command =
  | { name: 'init' }
  | { name: 'start'; interactive: boolean; dryRun: boolean; configPath?: string }
  | { name: 'status' | 'metrics' | 'rescan'; configPath?: string }
  | { name: 'approve'; taskId: string; configPath?: string }
  | { name: 'plan'; goal?: string; filePath?: string; configPath?: string }
  | { name: 'benchmark'; suite?: string; list: boolean; configPath?: string }
  | { name: 'improve'; resultsPath?: string; apply: boolean; configPath?: string };

const valueOf = (args: string[], flag: string) => {
  const index = args.indexOf(flag), value = index >= 0 ? args[index + 1] : undefined;
  return index >= 0 && !value ? err('CONFIG_ERROR', `${flag} requires a value`) : ok(value);
};
const positionals = (args: string[], flags: string[]) => args.filter((arg, index) => !arg.startsWith('--') && !flags.some(flag => args[index - 1] === flag));
const configPathOf = (args: string[]) => valueOf(args, '--config');

function parseCommand(argv: string[]): Result<Command> {
  const [command, ...args] = argv, configPath = configPathOf(args); if (!configPath.ok) return configPath;
  if (command === 'init' && args.length === 0) return ok({ name: 'init' });
  if (command === 'start') return ok({ name: 'start', interactive: args.includes('--interactive'), dryRun: args.includes('--dry-run'), configPath: configPath.value });
  if (command === 'status' || command === 'metrics' || command === 'rescan') return ok({ name: command, configPath: configPath.value });
  if (command === 'approve') { const taskId = positionals(args, ['--config'])[0]; return taskId ? ok({ name: 'approve', taskId, configPath: configPath.value }) : err('CONFIG_ERROR', 'approve requires a task id'); }
  if (command === 'plan') {
    const filePath = valueOf(args, '--file'); if (!filePath.ok) return filePath;
    const goal = positionals(args, ['--config', '--file']).join(' ').trim() || undefined;
    return goal && filePath.value ? err('CONFIG_ERROR', 'plan accepts either a goal or --file, not both') : goal || filePath.value ? ok({ name: 'plan', goal, filePath: filePath.value, configPath: configPath.value }) : err('CONFIG_ERROR', 'plan requires a goal or --file');
  }
  if (command === 'benchmark') {
    const suite = valueOf(args, '--suite'); if (!suite.ok) return suite;
    return args.includes('--list') || suite.value ? ok({ name: 'benchmark', suite: suite.value, list: args.includes('--list'), configPath: configPath.value }) : err('CONFIG_ERROR', 'benchmark requires --suite or --list');
  }
  if (command === 'improve') { const resultsPath = valueOf(args, '--results'); return resultsPath.ok ? ok({ name: 'improve', resultsPath: resultsPath.value, apply: args.includes('--apply'), configPath: configPath.value }) : resultsPath; }
  return err('CONFIG_ERROR', USAGE);
}

async function runCli(argv: string[]): Promise<Result<void>> {
  const command = parseCommand(argv); if (!command.ok) return command;
  if (command.value.name === 'init') return handleInit();
  if (command.value.name === 'start') return handleStart(command.value.interactive, command.value.dryRun, command.value.configPath);
  if (command.value.name === 'status') return handleStatus(command.value.configPath);
  if (command.value.name === 'metrics') return handleMetrics(command.value.configPath);
  if (command.value.name === 'rescan') return handleRescan(command.value.configPath);
  if (command.value.name === 'approve') return handleApprove(command.value.taskId, command.value.configPath);
  if (command.value.name === 'plan') return handlePlan(command.value.goal, command.value.filePath, command.value.configPath);
  if (command.value.name === 'benchmark') return handleBenchmark(command.value.suite, command.value.list, command.value.configPath);
  if (command.value.name === 'improve') return handleImprove(command.value.resultsPath, command.value.apply, command.value.configPath);
  return err('CONFIG_ERROR', USAGE);
}

const result = await runCli(process.argv.slice(2));
if (!result.ok) { console.error(result.error.message); process.exitCode = 1; }
