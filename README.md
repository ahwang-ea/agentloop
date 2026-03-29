# agentloop

Autonomous AI coding orchestrator with enforced quality loops.

You chat. It codes, verifies, reviews, and merges. The process can't be skipped.

## Quick start

```bash
# In any repo:
npx agentloop init
# Scaffolds: AGENTS.md, ARCHITECTURE.md, verify.sh, .claude/settings.json (hooks)

# Requires Claude Code auth plus OPENAI_API_KEY for Codex review:
OPENAI_API_KEY=... npx agentloop start --interactive
# Prompts for a task description, queues it, then runs the orchestrator
```

## What it does

For each task, the orchestrator enforces:

1. **Write** — Claude codes on a branch (hooks auto-verify every edit)
2. **Review** — Opus checks architecture fit, Codex checks edge cases (parallel)
3. **Cleanup** — Remove dead code, TODOs, incomplete paths
4. **Merge** — Squash to main, rebase other branches
5. **Notify** — Slack ping if behavior changed, auto-create README update task

No step is skippable. Enforcement comes from code + hooks, not prompts.

## Architecture

Three enforcement layers:

- **Claude Code Hooks** — fires on every file edit. Runs `verify.sh`, blocks out-of-scope writes.
- **Agent SDK orchestrator** — TypeScript state machine. Controls task flow, triggers reviews, manages git.
- **Repo files** — `AGENTS.md` + `ARCHITECTURE.md` guide how code is written. Hooks + orchestrator ensure process.

## For operators

You never need to remember the process. The interactive start flow accepts a natural-language task description and handles the rest.

## Building this package

This package uses the same framework it enforces. See `AGENTS.md`, `ARCHITECTURE.md`, and `verify.sh`.
Types live in `src/types/`. Run `npm run verify` to execute the package verification flow.
