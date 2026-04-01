# AGENTS.md

## What this project does
An npm package (agentloop) that orchestrates AI coding agents with
enforced quality loops. Operators describe goals, agents build autonomously.

## Commands
init, start, status, metrics, rescan, approve, plan, benchmark, improve.

## Stack
TypeScript 5.x (ESM), Node 20+, claude-agent-sdk, openai SDK, Codex CLI,
git CLI, @slack/webhook. Zero other runtime dependencies.

## Core principles
- Axiom 18: if it must happen, it's code. Not a prompt, not prose.
- Axiom 19: every change is a migration. Additive-only by default.
- Axiom 20: trace blast radius before changing shared types.
- Axiom 21: touch metal. Verify external assumptions against reality.
- Axiom 22: eliminate wasted work. Speed and accuracy are the same thing.
  Exploit agent parallelism: shotgun, pipeline, speculative execution.

## Conventions
- All functions that can fail return Result<T> (see src/shared/result.ts)
- Use ok() and err(code, message) helpers — never throw
- ErrorCode is a typed union — branch on .error.code, not string matching
- Max 150 lines per file. Split if approaching the limit.
- Pure functions, no classes. Dependencies passed as arguments.
- One file = one responsibility
- Write/fix operations return WriterOutput (not SessionOutput)
- SessionOutput is for Claude-specific session control (chat, review) only
- Log metrics at ALL terminal paths via shared logTaskMetrics() helper
- GC, metrics, sweep are best-effort — failures log to stderr, never halt
- Every .agentloop/ artifact has an owner, lifecycle, and cleanup rule
- Persisted types carry a version field. Reader code handles all versions.
- Changes to shared types require checking all importers for compatibility.
- Additive-only changes to persisted formats by default. Never remove or
  rename a field without a migration.

## Test conventions
Tests must run in parallel (jest --maxWorkers=100%). If they can't,
the code has hidden shared state — fix the code, not the test runner.
- Each test creates its own deps. No shared mutable state between tests.
- No shared database, files, ports, env vars, or mocks across tests.
- Use mkdtemp for temp files, port 0 for servers, in-memory DBs.
- Clean up in afterEach. restoreAllMocks in afterEach.
- Each test under 1 second. Network/API = integration test (merge only).
- Deterministic: seed randomness. Flaky = broken.

## Parallelism patterns
- Types and interfaces first — the contract IS the coordination mechanism
- One agent = one concern = distinct files. Same file = merge conflicts.
- Match model to task: cheap for search/exploration, expensive for planning
- Read-only agents for exploration, write agents for implementation only
- AGENTS.md and ARCHITECTURE.md are shared context — coordination lives there

## Patterns to follow
- Types: domain in src/types/domain.ts, adapters in src/types/adapters.ts
- Barrel: src/types/index.ts re-exports — import from './types/index.js'
- Task routing: TaskType determines which model writes, not ModelPreference
- Writer abstraction: writer.ts picks Claude or Codex based on config
- Scope enforcement: hooks block Claude, orchestrator reverts Codex
- Progressive verify: tsc → related tests (iteration), full suite + lint (merge)
- Review: sequential — Codex detail first, then Claude coherence sweep
- Fixes: always fresh writer session, never the review session
- Gardening rings: Ring 0-1 code-enforced, Ring 2 code-checked, Ring 3 code-triggered

## Module structure
- src/cli.ts — CLI entry, command parsing
- src/orchestrator.ts — state machine: pick → write → verify → review → merge
- src/types/ — domain.ts, adapters.ts, config.ts
- src/shared/ — result.ts (Result<T>, ErrorCode, ok/err)
- src/core/ — business logic:
    writer.ts, codex-writer.ts, task-runner.ts, research-task.ts,
    verifier.ts, verify-loop.ts, reviewer.ts, review-loop.ts,
    scaffold.ts, scope.ts, metrics.ts, metrics-report.ts,
    learnings.ts, gc.ts, gc-retention.ts, session-budget.ts,
    sweep.ts, sweep-checks.ts, task-queue.ts, finalizer.ts,
    notifier.ts, planner.ts, benchmark.ts, improver.ts,
    init.ts, scanner.ts, smart-init.ts
- src/benchmarks/ — suite types and definitions
- templates/ — scaffolding for target repos
- hooks/ — Python hook scripts for target repos
- benchmarks/results/ — gitignored benchmark output

## Do NOT
- Add runtime dependencies beyond the SDKs
- Use classes or inheritance
- Throw exceptions (use err())
- Write to tasks.json directly (use TaskQueueAdapter.add)
- Put prompt instructions where code enforcement is possible
- Create stateful artifacts without defining max size + cleanup
- Swallow errors silently (log to stderr at minimum)
- Remove or rename fields in persisted types without a migration
- Change shared interfaces without checking all consumers
- Add features without tests
