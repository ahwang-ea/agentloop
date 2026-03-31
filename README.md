# agentloop

Autonomous AI coding orchestrator with enforced quality loops.

You chat. It codes, verifies, reviews, and merges. The process can't be skipped.

## Quick start

```bash
# In any repo:
npx agentloop init
# Scaffolds hooks/commands, scans the repo, and drafts repo-specific docs

# Requires Claude Code auth plus OPENAI_API_KEY for Codex review:
OPENAI_API_KEY=... npx agentloop start --interactive
# Prompts for a task description, scopes monorepo work to one package, then runs the orchestrator

# Non-interactive helpers:
npx agentloop status
npx agentloop rescan
npx agentloop approve <task-id>
```

## What it does

For each task, the orchestrator enforces:

1. **Write** — Claude codes on an isolated worktree branch (scope hook blocks bad edits)
2. **Verify** — `verify.sh` runs when the agent stops, then the orchestrator verifies/fixes as needed
3. **Review** — Opus checks architecture fit, Codex checks edge cases (parallel)
4. **Cleanup** — Remove dead code, TODOs, incomplete paths
5. **Merge** — Squash to main, rebase other branches
6. **Notify** — Slack ping if behavior changed, auto-create README update task

No step is skippable. Enforcement comes from code + hooks, not prompts.

## Architecture

Three enforcement layers:

- **Claude Code Hooks** — blocks out-of-scope writes immediately, then runs `verify.sh` once when the agent stops.
- **Agent SDK orchestrator** — TypeScript state machine. Controls task flow, triggers reviews, manages git.
- **Repo files** — `AGENTS.md` + `ARCHITECTURE.md` guide how code is written. Hooks + orchestrator ensure process.

## For operators

You never need to remember the process. The interactive start flow accepts a natural-language task description and handles the rest.

## Building this package

This package uses the same framework it enforces. See `AGENTS.md`, `ARCHITECTURE.md`, and `verify.sh`.
Types live in `src/types/`. Run `npm run verify` to execute the package verification flow.

## Supply chain protection

This repo now includes Socket guardrails for dependency changes and installs.

- CI uses Socket Firewall Free to run `sfw npm ci` on pushes and pull requests.
- `.github/workflows/socket-security.yml` also supports full Socket scans when the `SOCKET_SECURITY_API_KEY` GitHub secret is configured.
- `socket.yml` narrows Socket GitHub scanning to `package.json` and `package-lock.json` changes.
- Root `.npmrc` sets `min-release-age=7`, and CI upgrades to npm `11.11.0` before install so the age gate is enforced consistently.
- For local protection, install Socket CLI with `npm install -g socket`, run `socket wrapper on`, then restart your terminal or source your shell rc file.
- If you prefer command-prefix mode, install `sfw` with `npm i -g sfw` and use `sfw npm ci` / `sfw npm install`.
- After enabling the Socket GitHub App, make `Socket Security: Pull Request Alerts` a required check on `main`.
