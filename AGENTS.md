# AGENTS.md

## What this project does
An npm package (agentloop) that orchestrates AI coding agents with enforced quality loops.
Two commands: `agentloop init` (scaffold a repo) and `agentloop start` (run the orchestrator).

## Stack
TypeScript 5.x, Node 20+, claude-agent-sdk, openai SDK, simple-git.

## Conventions
- All functions return Result<T> for operations that can fail (see src/shared/result.ts)
- Use ok() and err() helpers, never throw
- Max 150 lines per file
- Pure functions, no classes
- One file = one responsibility

## Patterns to follow
- Types: see src/types.ts — every interface lives here
- Result pattern: see src/shared/result.ts
- For goals and constraints: see ARCHITECTURE.md

## Module structure
- src/cli.ts — entry point, two commands
- src/orchestrator.ts — main state machine loop
- src/adapters/ — SDK wrappers (claude.ts, codex.ts)
- src/core/ — business logic (convergence, verifier, reviewer, behavior, branch, notifier, task-queue)
- src/shared/ — shared utilities (result.ts)
- templates/ — scaffolding for target repos
- hooks/ — Python hook scripts for target repos

## Do NOT
- Add dependencies beyond: claude-agent-sdk, openai, @slack/webhook, simple-git
- Use classes
- Throw exceptions
- Put types outside src/types.ts
- Create abstractions or base classes
- Over-engineer: this is ~1000 lines total, keep it simple
