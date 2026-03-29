# AGENTS.md

## What this project does
An npm package (agentloop) that orchestrates AI coding agents with enforced quality loops.
Two commands: `agentloop init` (scaffold a repo) and `agentloop start` (run the orchestrator).

## Stack
TypeScript 5.x, Node 20+, claude-agent-sdk, openai SDK, git CLI.

## Conventions
- All functions return Result<T> for operations that can fail (see src/shared/result.ts)
- Use ok() and err(code, message) helpers, never throw
- Error codes are typed — branch on .error.code, not string matching
- Max 150 lines per file
- Pure functions, no classes
- One file = one responsibility

## Patterns to follow
- Types: domain types in src/types/domain.ts, adapters in src/types/adapters.ts, config in src/types/config.ts
- Barrel: src/types/index.ts re-exports everything — import from './types/index.js'
- Result pattern: see src/shared/result.ts (OrchestratorError with typed ErrorCode)
- For goals and constraints: see ARCHITECTURE.md

## Module structure
- src/cli.ts — entry point, two commands
- src/orchestrator.ts — main state machine loop
- src/types/ — all type definitions (domain.ts, adapters.ts, config.ts, index.ts)
- src/core/ — business logic (convergence, verifier, reviewer, behavior, sweep)
- src/shared/ — shared utilities (result.ts)
- templates/ — scaffolding for target repos
- hooks/ — Python hook scripts for target repos

## Do NOT
- Add dependencies beyond: claude-agent-sdk, openai, @slack/webhook
- Use classes
- Throw exceptions
- Create abstractions or base classes
- Over-engineer: this is ~1000 lines total, keep it simple
