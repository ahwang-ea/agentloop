# agentloop — Architecture

An npm package that orchestrates AI coding agents with enforced quality loops.
Operators chat naturally. The process is enforced by code, not prompts.

## Goals
1. Every task goes through: write → verify → review → cleanup → merge. No step is skippable.
2. Operators interact by chatting. They never need to remember the process.
3. Enforcement comes from deterministic code (hooks + state machine), not LLM compliance.
4. Works on any repo that has AGENTS.md + verify.sh. No framework lock-in.

## Constraints
- Under 1000 lines total. Each file under 150 lines.
- No classes. Plain functions + types. Match the pattern we enforce on target repos.
- All operations that can fail return Result<T>. Never throw.
- Zero runtime dependencies beyond the three SDKs (claude-agent-sdk, openai, @slack/webhook).
- TypeScript strict mode.

## Tech Stack
- TypeScript 5.x, Node 20+
- claude-agent-sdk for Claude Code as a library
- openai SDK for Codex review calls
- Claude Code Hooks (.claude/settings.json) for per-action enforcement
- simple-git for git operations

## Three Enforcement Layers

### Layer 1: Claude Code Hooks (per-action, deterministic)
Configured in .claude/settings.json of the TARGET repo.
- PostToolUse (Write|Edit|MultiEdit) → runs verify.sh after every file change
- PreToolUse (Write|Edit|MultiEdit) → scope-check.py blocks out-of-scope edits
- Stop → signals orchestrator that the agent session ended
These fire automatically. Claude cannot bypass them.

### Layer 2: Orchestrator State Machine (per-task, deterministic)
TypeScript code in orchestrator.ts. A simple loop:
  pick task → spawn claude session → wait for stop →
  run parallel reviews (Opus + Codex) → fix if needed →
  cleanup pass → merge → behavior check → notify → next task
Each transition is an if-statement, not a prompt.

### Layer 3: Repo Files (guidance, not enforcement)
AGENTS.md, ARCHITECTURE.md, example files in the target repo.
Claude reads these to know HOW to write code.
Quality of guidance affects round count, not correctness of process.

## Key Design Decisions

| Date | Decision | Reasoning |
|------|----------|-----------|
| 2026-03-29 | Agent SDK over CLI wrapper | SDK gives programmatic control; CLI is string parsing |
| 2026-03-29 | Hooks for verify, not orchestrator | Hooks fire on EVERY edit, not just when orchestrator checks |
| 2026-03-29 | Parallel reviews (Opus + Codex) | Decorrelated blind spots: intuitive vs pedantic |
| 2026-03-29 | Convergence detection, not fixed retries | Some tasks need 2 rounds, some need 12. Measure, don't guess. |
| 2026-03-29 | Result<T> over exceptions | Matches what we enforce on target repos |
| 2026-03-29 | File-based task queue as default | Simplest. Linear adapter is optional. |
| 2026-03-29 | Interactive + headless modes | Interactive for Conductor chat. Headless for background runs. |

## Module Responsibilities

cli.ts — Entry point. Two commands: init and start. Parses args, loads config, calls orchestrator.

orchestrator.ts — The state machine loop. Picks tasks, manages the write→verify→review→merge pipeline. Handles convergence classification and escalation. This is the core file.

adapters/claude.ts — Wraps claude-agent-sdk. Sends prompts, receives responses. Handles session management.

adapters/codex.ts — Wraps OpenAI SDK. Sends review requests to Codex. Returns structured findings.

core/convergence.ts — Tracks round-over-round error counts. Classifies as converging/stuck/thrashing. Triggers web search on repeated errors.

core/verifier.ts — Runs verify.sh as a subprocess. Parses output into structured VerifyError[]. Computes error hashes for convergence comparison.

core/reviewer.ts — Runs Opus big-picture and Codex detail reviews in parallel. Merges findings. Formats fix prompt.

core/behavior.ts — Analyzes git diff for externally visible changes. Classifies by type (endpoint, config, schema, etc). Determines if README update needed.

core/branch.ts — Git operations: create branch, commit, diff, merge, rebase. Uses simple-git.

core/notifier.ts — Slack webhook. Formats notifications by type (behavior change, escalation, sweep).

core/task-queue.ts — Reads/writes task queue. Default: tasks.json in repo. Optional: Linear API adapter.

shared/result.ts — The Result<T> type and ok/err helpers. Same pattern as target repos.

templates/ — Scaffolding files for `agentloop init`. AGENTS.md, ARCHITECTURE.md, verify.sh templates, .claude/settings.json with hooks pre-configured.

hooks/ — Python scripts for Claude Code hooks. scope-check.py (PreToolUse) and on-stop.py (Stop). Shipped as templates, copied into target repos on init.
