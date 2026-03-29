#!/usr/bin/env node
// cli.ts — Entry point for agentloop.
// Two commands: init (scaffold a repo) and start (run the orchestrator).

import type { InitOptions, StartOptions, AgentloopConfig } from './types.js';
import { runOrchestrator } from './orchestrator.js';
import { ok, err } from './shared/result.js';

const DEFAULT_CONFIG: AgentloopConfig = {
  repoPath: '.',
  verifyCommand: './verify.sh',
  agentsMdPath: 'AGENTS.md',
  architectureMdPath: 'ARCHITECTURE.md',
  claudeModel: 'claude-opus-4-6',
  codexEnabled: true,
  convergence: {
    maxWallClock: 1800,
    maxTokens: 500000,
    stuckThreshold: 3,
    thrashOverlapRatio: 0.5,
  },
  taskSource: 'file',
  taskFilePath: 'tasks.json',
  maxParallelAgents: 1,
  parallelVerify: true,
  sweepInterval: 10,
};

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'init':
      await handleInit();
      break;
    case 'start':
      await handleStart(args.includes('--interactive'), args.includes('--dry-run'));
      break;
    case 'status':
      await handleStatus();
      break;
    default:
      console.log('Usage: agentloop <init|start|status>');
      console.log('  init              Scaffold AGENTS.md, ARCHITECTURE.md, verify.sh, hooks');
      console.log('  start             Run the orchestrator');
      console.log('  start --interactive  Run with chat interface');
      console.log('  status            Show current task states');
      process.exit(1);
  }
}

async function handleInit(): Promise<void> {
  // TODO: Implement — prompt for project name, stack, goals
  // Copy templates/ into current directory
  // Create .claude/settings.json with hooks
  // Create .agentloop/ directory for runtime state
  console.log('agentloop init — scaffold a repo for agent development');
  console.log('TODO: implement scaffolding');
}

async function handleStart(interactive: boolean, dryRun: boolean): Promise<void> {
  // TODO: Implement — load config, create adapters, run orchestrator
  // In interactive mode: wrap orchestrator with chat interface
  // In headless mode: run orchestrator loop, notify via Slack
  console.log(`agentloop start (interactive: ${interactive}, dryRun: ${dryRun})`);
  console.log('TODO: implement orchestrator startup');
}

async function handleStatus(): Promise<void> {
  // TODO: Implement — read .agentloop/ state files, show task states
  console.log('agentloop status');
  console.log('TODO: implement status display');
}

main().catch(console.error);
