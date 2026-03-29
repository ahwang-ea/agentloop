# agentloop

Autonomous AI coding orchestrator with enforced quality loops.

You chat. It codes, verifies, reviews, and merges. The process can't be skipped.

## Quick start

```bash
# In any repo:
npx agentloop init
# Scaffolds: AGENTS.md, ARCHITECTURE.md, verify.sh, .claude/settings.json (hooks)

npx agentloop start --interactive
# Opens chat. You describe what to build. It handles everything.
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

- **Claude Code Hooks** — fires on every file edit. Runs verify.sh, blocks out-of-scope writes.
- **Agent SDK orchestrator** — TypeScript state machine. Controls task flow, triggers reviews, manages git.
- **Repo files** — AGENTS.md + ARCHITECTURE.md guide HOW code is written. Hooks + orchestrator ensure WHAT PROCESS is followed.

## For operators

You never need to remember the process. The orchestrator tells you:
- What it did ("wrote the service, verify passed, Codex found 2 issues, fixed them")
- What changed ("new endpoint POST /orders/cancel, new env var CANCEL_WINDOW_MINUTES")
- What's next ("3 tasks remaining, want me to start the next one?")

You just say "yes" or "change X."

## Building this package

This package uses the same framework it enforces. See AGENTS.md and ARCHITECTURE.md.
Types are defined first in src/types.ts. Everything else implements against them.
