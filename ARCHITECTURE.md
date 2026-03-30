# agentloop — Architecture

An npm package that orchestrates AI coding agents with enforced quality loops.
Operators chat naturally. The process is enforced by code, not prompts.

Note: this document describes the TARGET architecture. The current codebase
implements a subset. See PHASE2_HANDOFF.md for tasks that bridge the gap.

## Goals
1. Every task goes through: write → verify → review → cleanup → merge. No step is skippable.
2. Operators interact by chatting. They never need to remember the process.
3. Enforcement comes from deterministic code (hooks + state machine), not LLM compliance.
4. Works on any repo that has AGENTS.md + verify.sh. No framework lock-in.

## Constraints
- Under 4000 lines total. Each file under 150 lines.
- No classes. Plain functions + types. Match the pattern we enforce on target repos.
- All operations that can fail return Result<T>. Never throw.
- Zero runtime dependencies beyond the SDKs (claude-agent-sdk, openai, @slack/webhook).
- TypeScript strict mode.

## 14 Axioms of AI Agent Coding

1. Lazy/satisficing — multi-pass needed, never trust a single output
2. Context quality = output quality — curate minimum correct context
3. Pattern replicators — canonical examples drive quality more than instructions
4. Decorrelated blind spots — two models catch more than two passes of one
5. Stateless — repo files ARE the memory, sessions are disposable
6. Only execution reveals truth — run, don't read
7. Drift without boundaries — explicit scope per task or agents wander
8. Small tasks >> big tasks — 1-3 files max per task
9. Errors > instructions — pipe compiler/test output directly, not "please fix"
10. Thrash after extended iterations — escalate, don't spin
11. Garbage compounds exponentially — mandatory cleanup every task
12. Frontloading structure eliminates rounds — types + tests first
13. Three alignment levels — code vs plan, plan vs goals, goals vs human want
14. IQ degrades non-linearly with context — maximize signal per token, prefer zero-context enforcement (types, tests, hooks) over prompt-based enforcement

## Tech Stack
- TypeScript 5.x, Node 20+
- claude-agent-sdk (Claude Code as a library — planning, architecture review, sweep)
- openai Codex CLI non-interactive mode (code writing)
- openai SDK (Codex detail review via chat API)
- Claude Code Hooks (.claude/settings.json) for per-action enforcement
- Codex Hooks (.codex/hooks.json) for Codex sessions (Bash interception only today)
- Git CLI via child_process + git worktree for parallel isolation

Note: Codex writes code via its CLI in non-interactive/full-auto mode, not
via the OpenAI chat API. The chat API cannot do agentic file editing.
The Codex CLI reads AGENTS.md, edits files, and runs commands — same as
Claude Code but with a different model. The orchestrator spawns Codex CLI
sessions for implementation and Claude Agent SDK sessions for planning.

Type safety notes:
- SessionOutput assumes Claude-specific fields (stopReason with hook semantics,
  tokensDelta from Claude usage). Codex CLI produces different output. Solution:
  define a WriterOutput type that both adapters return: text, changedFiles,
  tokenEstimate (0 if unknown from Codex CLI, exact from Claude). No `success`
  field — redundant with Result wrapper. Update all write/fix call sites.
- TaskType ('research'|'implement'|'integrate'|'debug') is the routing signal.
  TaskType determines which model writes, not a separate field.

## Model Roles

Claude Opus = PM. Talks to operator, understands intent, makes plans, writes
types/tests/scaffolds, reviews for architectural coherence (final sweep using
long-context strength).

Codex = Engineer. Writes code, self-reviews for detail/correctness, fixes
findings. More careful with existing codebases, better at code correctness
and thoroughness.

Review flow: Codex writes → Codex self-reviews (details) → Claude final
sweep (coherence) → merge. Fixes always happen in a fresh writer session,
never in the review session. This avoids the defending-your-own-code bias.
When Codex self-review finds issues, a new Codex session fixes them.
When Claude sweep finds issues, a new Codex session fixes those too.

## Context-IQ Tradeoff

Context is a cost, not just a benefit. There is a peak on the context-IQ
curve — too little and the agent lacks info, too much and reasoning degrades
non-linearly. The goal is hitting the peak for each task type.

| Task type | Context loaded | Why |
|-----------|---------------|-----|
| Implement | Scaffold + failing tests + golden file | Tests define behavior, types define shape. Near peak. |
| Fix errors | Error output + the one broken file | Error message IS the instruction. |
| Detail review | Diff + task description | Codex checks mechanics, doesn't need architecture. |
| Architecture review | Diff + ARCHITECTURE.md | The ONE task needing big context. Use Opus. |
| Planning | ARCHITECTURE.md + type files | No source code bodies. Types are contracts. |
| Sweep | File tree + file sizes | Not file contents. Just structure. |

Signal density matters more than total context length. Prefer zero-context
enforcement (types, tests, hooks, lint rules) over prompt instructions.

## Four Task Types

Not all tasks go through the same loop.

### Research (Claude, exploratory)
"Which webhook library? What's the Stripe API shape?"
Uses web search. Reads docs. Evaluates packages.
Output: adapter interface file + detailed notes in .agentloop/research/.
Decision row added to ARCHITECTURE.md decisions table.
Review: human approves the interface before implementation begins.

### Implement (Codex, precise — the fast loop)
"Build cancelOrder against the CancelAdapter interface."
Pure code. Tests mock the adapter. Types enforce the contract.
Scaffold + test-first + shotgun all apply. Fastest loop.

### Integrate (Codex, careful — real side effects)
"Wire the real Stripe adapter. Test against sandbox."
Hits real APIs. Needs credentials. Runs sequentially.
Success = integration tests pass against real/sandbox service.

### Debug (interactive — escalate to human)
"Auth token expires but refresh doesn't work."
Requires exploration, logs, real environment. Not automatable.
agentloop escalates to Slack, operator handles in Conductor.

A typical feature decomposes: research (1) → implement (3-5) → integrate (1) → debug (0-1).
80% is pure implementation against known interfaces. That's the fast loop.

## Adapter Boundary Pattern

Every external dependency gets a thin adapter behind a clean interface.
Service code depends on the interface, never the external thing directly.

    External world (Stripe, IBKR, Slack)
        ↕
    Adapter (thin, integration tested separately)
        ↕
    Interface (the contract — produced by research task)
        ↕
    Your service code (pure, unit tested against mock adapter)

This makes 80% of code pure and fast-loop eligible.

## Three Enforcement Layers

### Layer 1: Claude Code Hooks (per-action, deterministic)
Configured in .claude/settings.json of the TARGET repo.
- Stop → runs verify.sh when agent finishes (not per-edit, for speed)
- PreToolUse (Write|Edit|MultiEdit) → scope-check.py blocks out-of-scope edits
These fire automatically. Claude cannot bypass them. Zero context cost.

Codex also has hooks (.codex/hooks.json) with the same event model but
currently only intercepts Bash commands (not file edits). Scope-check on
Codex sessions is enforced by the orchestrator: check the diff after session
stops, reject if out-of-scope files were touched. When Codex hooks mature
to support file edit interception, switch to hook-based enforcement.

### Layer 2: Orchestrator State Machine (per-task, deterministic)
TypeScript code in orchestrator.ts. A simple loop:
  pick task → spawn session → verify loop → Codex self-review →
  Claude coherence sweep → fix if needed → cleanup → final verify →
  merge → behavior check → notify → next task
Each transition is an if-statement, not a prompt.

### Layer 3: Repo Files (guidance, not enforcement)
AGENTS.md, ARCHITECTURE.md, golden files in the target repo.
Claude reads these to know HOW to write code.
Quality of guidance affects round count, not correctness of process.

## Speed Optimizations

### Maximize P(correct) per attempt
- Test-first scaffolding: PM writes types + stubs + failing tests. Engineer fills in bodies.
- Branded types: OrderId vs UserId — compiler catches cross-type errors at zero cost.
- Zod contracts: runtime validation at module boundaries.
- Golden file pattern: copy + rename + fill in, not generate from scratch.
- Diff-based prompts: show agent exactly where and what signature.
- Proof comments: agent writes brief proof of why code is correct.

### Detect errors faster
- Progressive verify: tsc (1ms) → related tests (2s) → full suite (merge only) → lint (merge only).
- Parallel tests: pure functions + injected deps = all CPU cores. Target: full verify under 2 seconds.
- Incremental tsc: `"incremental": true` in tsconfig.
- Checkpoint diffing: large diff on a small fix = agent flailing, restart fresh.
- Mutation testing: flip logic, do tests still pass? If yes, tests are weak.
- Inverse testing: second agent tries to BREAK the code.
- Property tests: invariants catch edge cases no one thought to write.

### Increase throughput
- Shotgun execution: 3 agents simultaneously, different prompts, first to pass wins. P(≥1 correct) = 97%.
- Pipeline parallelism: Claude plans task N+1 while Codex implements task N.
- Speculative execution: start next task during review.
- Warm sessions: reuse Claude session for related tasks in same feature.
- Feature branch parallelism: 3-4 features each with own agent.
- Minimum context loading: fewer tokens = smarter reasoning = fewer rounds.

### Alignment
- Contrast-based options: show 2-3 concrete behaviors, human picks in 2 seconds.
- Incremental delivery: types first → approve → implement → approve.
- Intent confirmation: Claude PM summarizes understanding before coding.

## Observability

One file: .agentloop/metrics.jsonl (append-only, one line per task).
Five numbers: avg rounds, avg time, first-pass rate, stuck rate, top error.
One command: /metrics slash command for conversational summary.

What each number tells you:
- Rounds increasing → AGENTS.md needs better examples
- Stuck rate up → tasks are too big or ambiguous
- Same top error recurring → encode as lint rule / test helper / type constraint
- First-pass rate dropping → scaffold needs tightening or signal density problem

## Learning Model

Bounded, not sprawling.

Preferred: encode learnings as code (zero context cost).
- Common mistake → lint rule
- Missing check → test helper
- Type confusion → branded type
Enforced forever, no context tokens spent.

Fallback: learnings.json (max 10 items, only 2-3 injected per task based on
relevance). Least-triggered pruned.

Self-evolving AGENTS.md: every 20 tasks, an agent reads the last 20
metrics.jsonl entries, counts error frequencies, groups by module, and
proposes AGENTS.md edits. For each proposed rule, it first checks: can this
be a lint rule, test helper, or type constraint instead? Code enforcement
is always preferred over prose. The proposal goes to Slack for human
approval — never auto-applied. Hard cap: AGENTS.md stays under 100 lines.

## Garbage Leak Prevention

Rule: every stateful artifact needs a cap, a TTL, or a cleanup trigger.
If it doesn't have one of those three, it's a leak. (Axiom 11)

### Runtime state garbage collection
The finalizer runs a GC pass after every successful merge:
- Delete the task's worktree directory and base worktrees under _base/
- Delete the merged al/ branch (git branch -d)
- Prune notification idempotency keys older than 7 days
- Archive completed/stuck tasks older than 30 days from tasks.json
- Rotate metrics.jsonl if older than 90 days
- Prune .agentloop/archive.jsonl entries older than 180 days
- Prune .agentloop/metrics-archive/ files older than 1 year
- Prune .agentloop/archive/ (research notes) older than 180 days
- Force-remove stale .lock directories older than 5 minutes
- Clean up temp files (tasks.json.*.tmp, notifications.json.tmp)
- Remove smart-init artifacts (.agentloop/drafts/, init-questions.json,
  coverage.json) after init completes
- Evict completed sessions from the in-memory session Map in claude adapter

### Stateful artifacts inventory
All .agentloop/ files that need lifecycle management:
- current-scope.json — overwritten per task (no leak, but stale after crash)
- session-status.json — overwritten per session (same)
- inventory.json — overwritten on init/rescan (bounded, one file)
- intent-baseline.json — overwritten on intent check (bounded, one file)
- drafts/ — created during smart init, cleaned after init completes
- research/*.md — archived when feature merges to main

### Session context limits
Warm sessions are capped: fresh session after 3 tasks or 100k tokens,
whichever first. Without this, conversation history grows and IQ degrades
per Axiom 14.

Error output passed to fix prompts is truncated: first 50 lines + last
10 lines. The first error is usually the root cause. 10,000 lines of
test output in the prompt tanks reasoning quality.

### Sweep task deduplication
Architect sweep tasks are deduped by title hash. Max 10 sweep-generated
tasks in the queue at once. Prevents sweep from proposing the same
cleanup repeatedly.

### Code garbage (closed-loop rule)
Anything not in a closed loop is garbage. Enforce via zero-context checks:

Lint rules (per-edit, zero context cost):
- no-unused-vars, no-unused-imports (dead code)
- no-empty-catch → every catch must return err() or propagate via Result
- no-console → no debug artifacts in production code
- no-commented-out-code → delete it or keep it, not both
- no-todo-without-task-id → "// TODO(al-047): desc" ok, "// TODO: fix" fails

verify.sh checks (per-task):
- grep for naked TODO/FIXME/HACK without task ID → fail
- depcheck for unused packages → fail on merge

Cleanup pass enforcement:
- Orchestrator cleanup prompt: "Remove dead code, unused imports, debug
  statements. Do not add functionality. Only subtract."

Sweep catches pattern drift:
- "12 files use Result, 3 use try/catch" → creates migration task
- "ARCHITECTURE.md says X, code does Y" → creates alignment task

The principle: if a human wouldn't accept "I'll fix it later" in code
review, the toolchain shouldn't either. Enforce in lint, not in prompts.

## Feature Lifecycle

### Phase 1: Plan (you + Claude)
Claude reads ARCH.md + relevant modules. Proposes types, task breakdown,
risk areas. Shows contrast options for ambiguous decisions. You approve.

### Phase 2: Build (autonomous, parallel)
Types merge to feature branch first. Codex implements tasks in parallel
against frozen types. Each task goes through the full task loop.

### Phase 3: Feature gate (before merge to main)
Claude reviews full diff vs ARCHITECTURE.md (coherence).
Codex reviews full diff (cross-file correctness).
Auto-check: does this feature require ARCHITECTURE.md updates?
You approve the merge.

### Phase 4: Merge + update (atomic)
Merge to main. Update ARCHITECTURE.md + AGENTS.md in the same commit.
Slack notification with behavior changes. No window where code and docs disagree.

## Init / Onboarding

Smart init for existing repos (6 steps, bounded):
1. Deterministic scan (script, no LLM) → inventory.json
2. Claude reads inventory + key files → drafts AGENTS.md, ARCHITECTURE.md, MODULE.md
3. Codex checks draft against inventory → coverage score (42/45 items)
4. Human answers scenario-based questions (not technical jargon)
5. Claude revises, Codex re-checks
6. Done or label remaining as "known unknowns"

Hard stop: 2 human rounds max. Monorepo: MODULE.md per package, one task = one package.

## Ongoing Servicing

- Every 5-10 tasks: code vs docs sweep (automated, Codex alone)
- Every new feature: docs vs human intent check (Slack ping: "Still aligned?")
- Every major milestone: full re-inventory (re-run scanner, diff against previous)

## Conductor Coexistence

Same machine, same repos, different directories.
- Conductor: ~/conductor/workspaces/ (your manual work, any branch names)
- agentloop: ~/.agentloop/worktrees/ (automated work, al/ branch prefix)
- Shared: same .git, same main branch
- Merges flow through main. agentloop rebases on your merges. You pull on its merges.

## Documentation Hierarchy

Three levels, one entry point:
1. AGENTS.md (<100 lines, always read) → conventions, stack, do-nots
2. ARCHITECTURE.md + MODULE.md (read for planning/review) → goals, decisions
3. Code itself (read for implementation) → types=contracts, examples=patterns, tests=spec

No docs/ folder in target repos (agentloop package itself has docs/ for human guides).
No wiki. One fact, one place.
Cross-model memory: every architecture conversation ends with "update DECISIONS table."
Future: verify.sh should check doc freshness — behavior change without doc update = failure.
(Not yet implemented. Add to verify.sh template when behavior detection is in place.)

## Key Design Decisions

| Date | Decision | Reasoning |
|------|----------|-----------|
| 2026-03-29 | Agent SDK over CLI wrapper | SDK gives programmatic control; CLI is string parsing |
| 2026-03-29 | Hooks for scope-check (PreToolUse), verify on Stop | PostToolUse verify is too slow per edit. Stop hook verifies once. |
| 2026-03-29 | Claude = PM, Codex = engineer | Claude: intent/empathy/long-context. Codex: correctness/thoroughness. |
| 2026-03-29 | Codex writes → Codex self-reviews → Claude final sweep | Decorrelated review. Writer never reviews on architecture, reviewer never writes fix. |
| 2026-03-29 | Convergence detection, not fixed retries | Some tasks need 2 rounds, some need 12. Measure, don't guess. |
| 2026-03-29 | Result<T> over exceptions | Matches what we enforce on target repos |
| 2026-03-29 | Idempotent external side effects | Merge-commit-scoped keys so retries never produce duplicate notifications |
| 2026-03-29 | Four task types | Research/implement/integrate/debug need different loops and context |
| 2026-03-29 | Adapter boundary pattern | External deps behind interfaces. 80% of code stays pure and fast-loop eligible. |
| 2026-03-29 | Test-first scaffolding | PM writes failing tests. Engineer implements until pass. Often 1 round. |
| 2026-03-29 | Context budget per task type | IQ degrades with context. Load minimum per task. Implementation may skip AGENTS.md. |
| 2026-03-29 | Metrics-driven optimization | Build /metrics first. Only build speed optimizations the numbers justify. |
| 2026-03-29 | Learnings as code, not prose | Lint rules/test helpers/branded types over AGENTS.md additions. Zero context cost. |
| 2026-03-29 | al/ branch prefix + worktrees | Conductor coexistence. Different directories, no conflicts. |
| 2026-03-30 | Every stateful artifact: cap, TTL, or cleanup trigger | Axiom 11 applied to orchestrator. GC pass in finalizer after every merge. |
| 2026-03-30 | Closed-loop rule for code | No naked TODOs (must have task ID). No empty catches. No dead code. Enforce in lint. |
| 2026-03-30 | Session cap: 3 tasks or 100k tokens | Warm sessions degrade IQ per Axiom 14. Fresh session prevents context garbage. |
| 2026-03-30 | Error output truncation: 50+10 lines | Full test output tanks reasoning. First error is root cause. Truncate the rest. |
| 2026-03-30 | Codex hooks weaker than Claude hooks | Codex PreToolUse only fires on Bash, not file edits. Compensate with orchestrator-level scope check. |
