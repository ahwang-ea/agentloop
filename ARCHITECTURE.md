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
- Under 2000 lines total. Each file under 150 lines.
- No classes. Plain functions + types. Match the pattern we enforce on target repos.
- All operations that can fail return Result<T>. Never throw.
- Zero runtime dependencies beyond the SDKs (claude-agent-sdk, openai, @slack/webhook).
- TypeScript strict mode.

## 22 Axioms of AI Agent Coding

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
11. Maintenance is the product — the gardening loop IS the differentiator. Continuous tending, not end-of-task cleanup.
12. Frontloading structure eliminates rounds — types + tests first
13. Three alignment levels — code vs plan, plan vs goals, goals vs human want
14. IQ degrades non-linearly with context — maximize signal per token, prefer zero-context enforcement (types, tests, hooks) over prompt-based enforcement
15. Agent-native over agent-accessible — structure everything to maximize the probability agents WILL use it correctly. Type errors > lint rules > prose. Prefer native. Fall back to accessible only when native is impossible.
16. Graceful degradation — every subsystem defines its failure mode. No single subsystem failure halts the pipeline.
17. Every primitive must scale agent-natively — every stateful artifact needs: max active size, archival trigger, retrieval path, and maintenance owner. If it can't define all four, it's not ready.
18. If it must happen, it's code — prompt instructions are suggestions the agent may skip (Axiom 1). Critical invariants are code or tests. Hierarchy: type system > hooks > lint > tests > verify.sh > orchestrator > prompt > prose.
19. Every change to a running system is a migration — agents see code, not history. No change to persisted state, interfaces, schemas, or configs is "just a refactor." Additive-only by default. Breaking changes require versioning, migration functions, or compatibility windows.
20. Blast radius discovery is a prerequisite — before any change to a shared interface or persisted type, trace the full impact: who imports it, what reads it, what state exists in the old format. Code-enforced via pre-merge inventory cross-reference.
21. Touch metal — agents live in an abstraction bubble. Before depending on an external assumption (API shape, infra state, deployed config, production data format), verify against the real thing. Hit the endpoint. Query the database. Mocks are for tests; reality is for shipping.
22. Eliminate wasted work — speed and accuracy are the same thing. Test-first → fewer rounds. Progressive verify → fail fast. Minimal context → better reasoning. Types → errors at compile time. If you're choosing between speed and correctness, the architecture is wrong. Exploit agent parallelism: shotgun execution (3 agents, first to pass, P≥97%), pipeline parallelism (plan N+1 while implementing N), speculative execution (start next during review). Trade tokens for time.
23. Overfitting test — before adding guidance, prompt text, or architecture notes to a benchmark suite, apply this test: "If this specific benchmark disappeared, would this change still improve the framework?" If no, the change is overfitting to the benchmark, not improving the framework. Move the capability to the framework level (convention discovery, test exemplar selection, verification checks) instead of hardcoding it in the suite definition. Fix classes of failures, not individual tasks.

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
- TaskType ('research'|'implement'|'integrate'|'debug') replaces ModelPreference
  as the routing signal. ModelPreference should be removed or demoted to an
  override hint. TaskType determines which model writes, not a separate field.

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
  pick task → spawn session → verify loop → concurrent Codex detail review
  + Claude coherence sweep → fix if needed → cleanup → final verify →
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

### Agent parallelism patterns
Whether using Claude Code agent teams, Codex subagents, or agentloop workers,
the coordination pattern is the same:
- Types and interfaces first. The lead defines contracts. Agents implement
  against them. The interface IS the coordination mechanism.
- One agent = one concern = distinct files. Two agents on the same file = merge
  conflicts = wasted time. If they need the same file, split it.
- Match model to task. Cheap/fast for exploration and search. Expensive for
  planning and architecture review. Mid-tier for implementation.
- Read-only for exploration. Only implementation agents write files.
- Repo files (AGENTS.md, ARCHITECTURE.md) are shared context loaded
  automatically. That's the coordination layer, not messages between agents.

### Test isolation (enables parallel tests AND parallel agents)
Tests MUST run in parallel (jest --maxWorkers=100%). If they can't, the code
has hidden shared state — fix the code, not the test runner.
- No shared database — each test creates its own in-memory DB or unique name
- No shared files — use mkdtemp for unique temp dirs, clean up in afterEach
- No shared ports — use port 0 (OS picks a free port), never hardcode
- No shared env vars — restore in afterEach, or inject config as parameter
- No test ordering — if B fails when A doesn't run first, B is broken
- No shared mocks — fresh mocks per test, restoreAllMocks in afterEach
- Deterministic — seed randomness, flaky tests train agents to ignore failures
- Fast — each test under 1 second. Network/API tests are integration tests
  (merge only via progressive verify, not every iteration)

### Alignment
- Contrast-based options: show 2-3 concrete behaviors, human picks in 2 seconds.
- Incremental delivery: types first → approve → implement → approve.
- Intent confirmation: Claude PM summarizes understanding before coding.

## Agent-Native Design

Axiom 15 in practice. Every design decision should answer: "will an
agent do the right thing here by default, or does it have to be told?"

### The spectrum
From strongest (agent-native) to weakest (agent-accessible):

1. Type system — branded types, discriminated unions, required fields.
   Wrong code doesn't compile. Agent can't make the mistake.
2. Tests as spec — failing test defines the requirement. Agent's goal
   is making it pass. No interpretation needed.
3. Hooks — PreToolUse, Stop, SessionStart fire automatically. Agent
   can't skip them. Zero context cost.
4. Lint rules — no-unused-vars, no-empty-catch, no-console. Caught on
   every edit, no prompt needed.
5. verify.sh — runs on every task completion. Agent gets concrete
   error output, not instructions.
6. Golden files — copy + rename + fill in. Agent follows the pattern,
   not instructions about the pattern.
7. AGENTS.md — prose rules the agent reads. Better than nothing, but
   costs context tokens and compliance is probabilistic.
8. Prompt injection — learnings, cleanup instructions. Weakest. Most
   likely to be ignored or misinterpreted.

### Design checklist for new features
When adding a feature to agentloop or a target repo, ask (Axiom 18):
- Can I make the wrong thing a type error? → Do that. (strongest)
- Can I make the wrong thing a hook rejection? → Add the hook.
- Can I make the wrong thing a lint error? → Add the rule.
- Can I make the wrong thing a test failure? → Write the test first.
- Can I make the right thing the default? → Set the default.
- Can I make a code check that auto-creates a task? → Add to sweep-checks.
- None of the above? → Add it to AGENTS.md, but know it's weak. (weakest)

### Examples in this codebase
- Result<T> over exceptions: agents can't forget to handle errors
  because the type forces them to check .ok
- ScaffoldFile discriminated union: golden-copy has referencePath,
  others have content. Type-level, not a prose rule.
- Scope enforcement via hooks: agents can't edit forbidden files
  because the hook blocks the edit, not because AGENTS.md says don't.
- Progressive verify: tsc runs first because type errors are cheapest
  to detect. Structure guides the agent toward fast feedback.
- Session caps: agents don't decide when to start fresh — the
  orchestrator forces it. The right thing happens by default.

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

## Codebase Gardening

Gardening is not garbage collection. GC runs at the end to clean up
waste. Gardening is continuous: pruning, organizing, ensuring every
artifact is where agents will find it when they need it. The gardening
loop IS the product (Axiom 11). Without it, every system rots.

The goal isn't a clean repo. The goal is a repo that maximizes agent
performance on the next task. The structure itself guides agents to
do the right thing (Axiom 15).

### Enforcement hierarchy (Axiom 18)
If it must happen, it's code. Prompts are for things that tolerate
occasional failure and self-correct through repetition.

| Enforcement | Strength | Cost | Example |
|-------------|----------|------|---------|
| Type system | Compile error | Zero runtime | Result<T> forces error handling |
| Hooks | Blocks the action | Zero context | scope-check.py prevents forbidden edits |
| Lint rules | Fails verify | Zero context | no-unused-vars, no-empty-catch |
| verify.sh | Fails the task | Seconds | tsc, jest, depcheck, TODO grep |
| State machine | Skips to next step | None | orchestrator if-statements |
| Code checks | Creates tasks automatically | Cheap | file size, pattern drift, doc freshness |
| Prompt injection | Agent may follow | Tokens | learnings addendum, cleanup prompt |
| AGENTS.md prose | Agent may read | Tokens | conventions, do-nots |

Everything above the line (type system through code checks) is
deterministic. Everything below is probabilistic. Design for the
line. Push things above it whenever possible.

### Concentric gardening rings

Ring 0, 1, and 2 are code-enforced. Ring 3 is code-triggered but
prompt-executed. Ring 4 is human-triggered.

**Ring 0 — Every verify pass (seconds, code-enforced)**
Hooks fire automatically. Agent cannot bypass.

| Check | Enforced by | File |
|-------|-------------|------|
| Type errors | tsc --noEmit via verify.sh | hooks → verify.sh |
| Related tests | jest --findRelatedTests via verify.sh | hooks → verify.sh |
| Scope violations | scope-check.py PreToolUse hook | hooks/scope-check.py |
| Naked TODOs without task ID | grep in verify.sh | templates/verify.sh |
| Lint rules (unused vars, empty catch, console) | eslint via verify.sh | templates/verify.sh |

**Ring 1 — Every commit/merge (minutes, code-enforced)**
Orchestrator state machine runs these. No prompt, no compliance risk.

| Check | Enforced by | File |
|-------|-------------|------|
| Full test suite | progressiveVerify(mergeMode=true) | core/verifier.ts |
| Depcheck (unused packages) | verify.sh --merge | templates/verify.sh |
| Commented-out code | grep in verify.sh --merge | templates/verify.sh |
| Worktree cleanup | gc() in finalizer | core/gc.ts |
| Branch deletion | gc() in finalizer | core/gc.ts |
| Stale lock removal | clearStaleLock() | core/stale-lock.ts |
| Temp file cleanup | gc() in finalizer | core/gc.ts |
| Metrics logging | logTaskMetrics() at ALL 4 terminal paths | core/metrics.ts |
| Session eviction | evictTaskSessions() in gc | core/gc.ts |
| Session budget check | recordWarmSession() caps at 3/100k | core/session-budget.ts |
| Error truncation | truncateVerifyOutput() before fix prompt | core/verifier.ts |

**Ring 2 — Every feature completion (hours, code-enforced checks)**
Code-enforced checks that fire on feature merge:

| Check | Enforced by | File |
|-------|-------------|------|
| Sequential review (Codex detail → Claude coherence) | runSequentialReviews() | core/reviewer.ts |
| Architecture update check | needsArchitectureUpdate() | core/inventory-diff.ts |
| Doc freshness (code changed, docs didn't) | verify.sh doc-freshness check (NEW) | templates/verify.sh |
| Pattern drift (Result vs try/catch ratio) | sweep-checks.ts ratio check (NEW) | core/sweep-checks.ts |
| File size enforcement (>150 lines) | sweep-checks.ts size check | core/sweep-checks.ts |
| Test coverage ratio | sweep-checks.ts ratio check (NEW) | core/sweep-checks.ts |
| Learnings refresh | refreshLearnings() after terminal states | core/learnings.ts |

NEW code-enforced checks to add to Ring 2:

Doc freshness: in verify.sh merge mode, check git diff --name-only
between the merge base and HEAD. If any .ts file in src/ changed but
ARCHITECTURE.md and AGENTS.md did not, print a warning (not a hard
fail — some tasks legitimately don't affect docs). The sweep picks
up repeated warnings and creates an alignment task.

Pattern drift: in sweep-checks.ts, count occurrences of Result<
vs try/catch in the codebase. If the ratio drops below 80% Result,
create a migration sweep task. Pure code, no LLM.

Test coverage ratio: in sweep-checks.ts, count .test.ts files vs
.ts source files. If ratio drops below 0.3, create a sweep task to
add tests. Pure code.

**Ring 3 — Every N tasks / periodic (code-triggered, prompt-executed)**
Code triggers these at deterministic intervals. Claude/Codex execute
the judgment calls. Self-correcting through repetition (Axiom 18).

| Check | Trigger | Executor | File |
|-------|---------|----------|------|
| Architectural sweep | Every sweepInterval tasks (code counter) | Claude proposes, code enqueues | core/sweep.ts |
| AGENTS.md evolution | Every 20 tasks (metrics line count % 20) | Claude proposes, human approves | core/learnings.ts |
| Archive pruning | Every gc() pass (deterministic TTLs) | Pure code | core/gc-retention.ts |
| Full re-inventory | Every rescan command | Scanner (code) + Claude (analysis) | core/rescan.ts |

Even in Ring 3, the triggers are code. Claude only does the parts
that require judgment: "what sweep task to create" and "what AGENTS.md
rule to propose." The when and whether are never Claude's decision.

**Ring 4 — Operator-triggered (human judgment)**
Intentionally human. These are judgment calls, not automatable checks.

| Action | Trigger | Interface |
|--------|---------|-----------|
| "Still aligned?" intent check | Slack ping after feature completion | /approve slash command |
| Approve AGENTS.md proposals | Notification after Ring 3 proposes | /review-agents-update |
| Review benchmark trends | Operator runs agentloop improve | CLI |
| Approve research output | Notification after research blocks | /approve slash command |
| Full re-inventory review | Operator runs agentloop rescan | CLI |

### Scaling every primitive (Axiom 17)
Every .agentloop/ artifact must define all four columns or it's not ready.

| Artifact | Max active size | Archival trigger | Retrieval path | Owner |
|----------|----------------|------------------|----------------|-------|
| tasks.json | Unbounded (active tasks) | Done/stuck tasks archived at 30d | queue.list() | task-queue.ts |
| metrics.jsonl | Unbounded (append-only) | Rotated at 90d | metricsPath() | metrics.ts |
| learnings.json | 10 entries | Least-used pruned on update | learningsAddendum() | learnings.ts |
| notifications.json | Unbounded (append-only) | Keys pruned at 7d | notifier.ts | notifier.ts |
| archive.jsonl | Unbounded | Entries pruned at 180d | Not queried (cold storage) | gc-retention.ts |
| metrics-archive/ | Unbounded (files) | Files pruned at 1yr | Not queried (cold storage) | gc-retention.ts |
| archive/ | Unbounded (files) | Files pruned at 180d | Not queried (cold storage) | gc-retention.ts |
| inventory.json | One file | Overwritten on rescan | scanner.ts | scanner.ts |
| current-scope.json | One file | Overwritten per task | hooks/scope-check.py | orchestrator |
| research/*.md | Per-feature | Archived on feature merge | Not queried after archive | gc.ts |

### Degradation modes (Axiom 16)
Every gardening subsystem defines what happens when it fails.

| Subsystem | If it fails | Impact | Recovery |
|-----------|-------------|--------|----------|
| gc() | Stale worktrees/branches accumulate | Disk usage grows | Next gc() cleans up |
| logTaskMetrics() | Missing metrics entries | /metrics underreports | Next task logs normally |
| refreshLearnings() | Stale learnings injected | Slightly worse prompts | Next refresh corrects |
| sweep | Drift goes undetected longer | Code quality drifts | Next sweep catches up |
| truncateVerifyOutput() | Full output in prompt | IQ degrades for one fix | Next task starts clean |
| session eviction | Stale sessions in memory | Memory grows | Process restart clears |

No subsystem failure halts the pipeline. gc() is best-effort.
Metrics logging failures are logged to stderr but don't fail the task.
Sweep errors don't stop the orchestrator. The system works at reduced
capacity, never stops.

### Context gardening
The agent's context window is a garden too. Weeds are:
- Stale error output from 5 rounds ago (truncate to 50+10 lines)
- Warm sessions that have drifted (cap at 3 tasks or 100k tokens)
- Learnings that don't apply to this task (inject only 2-3 relevant ones)
- Full ARCHITECTURE.md in an implementation task (only load for planning)

Every token in the prompt either helps or hurts. There's no neutral.
Gardening the context means loading the minimum that hits the IQ peak
for each task type (see Context-IQ Tradeoff above).

### Code gardening (closed-loop rule)
Anything not in a closed loop is a weed. Enforce via zero-context checks:

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

### Sweep as gardening
Sweep walks the repo and proposes tasks for things that have drifted.
Deduped by title hash, max 10 in queue. It's the automated gardener.

Code-enforced sweep checks (deterministic, no LLM):
- File size: any file >150 lines → create split task
- Pattern drift: Result< vs try/catch ratio <80% → migration task
- Test ratio: test files / source files <0.3 → coverage task
- Doc freshness: repeated merge-mode warnings → alignment task

LLM-assisted sweep checks (Ring 3, prompt-executed):
- Undocumented modules → AGENTS.md task
- Undocumented env vars → docs task
- Architectural mismatch → alignment task

The principle: if a human wouldn't accept "I'll fix it later" in code
review, the toolchain shouldn't either. If the check is deterministic,
enforce it in code. If it requires judgment, trigger it in code and
let the LLM execute it.

## Change Safety (Axioms 19, 20)

Agents see the code as it is NOW. They don't see the state that has
accumulated over time — old experiment records, deployed configs,
running processes, downstream consumers. When an agent "improves" a
data format, renames a field, or restructures a config, everything
in the old format breaks silently.

### Migration hierarchy (strongest to weakest)
1. Additive-only — add fields with defaults, never remove/rename. DEFAULT.
2. Versioned schemas — records carry version, reader handles all known versions.
3. Migration functions — deterministic old→new transform, idempotent, tested.
4. Compatibility windows — old+new supported for N days, explicit deprecation.
5. Flag-gated rollout — new behavior behind a flag, old is default.
6. "Just change it" — what agents do by default. Structurally prevent this.

### Pre-merge blast radius review
Before any merge to main that touches a shared type, persisted format,
config schema, or adapter interface:

1. Auto-generate a systems inventory (code, not LLM): which types exist,
   who imports them, what reads/writes each persisted format, what configs
   are loaded where. AST analysis + file system scan.
2. Cross-reference the diff against the inventory: for each changed file,
   find every consumer, reader, writer, implementer.
3. Generate a checklist: HIGH risk (type/interface changed, all consumers
   listed), MEDIUM risk (write-side changed, readers listed), LOW risk
   (read-side changed, format unchanged).
4. Review agent or operator addresses each item before merge is allowed.
5. The reviewer is NOT the same agent that made the change (Axiom 4).

This can be CI-enforced (merge blocked without sign-off), process-enforced
(checklist posted to Slack/PR), or minimum-viable (printed to stdout).

### Agent-specific failure modes
- Agents don't read git history — they see current code, not accumulated state
- Agents optimize for clean code, not compatibility — they rename fields freely
- Agents don't know deployment topology — they don't know configs are deployed
- Agents take shortcuts — if they can skip impact analysis, they will
- Prevention must be code (CI, hooks, lint), not documentation

### Schema safety rules
- Persisted types must have a version field. Reader code handles all versions.
- Removing or renaming a field in a persisted type is a lint error without
  a corresponding migration file.
- Config files are validated by schema on load. Missing fields get defaults,
  not silent nulls.
- Contract tests load real old data with current code. If parsing fails,
  the change is incompatible.

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
| 2026-03-30 | Codebase gardening, not just GC | Axiom 11: continuous tending — prune, organize, label, ensure findability. Every artifact has owner + lifecycle. |
| 2026-03-30 | Agent-native over agent-accessible | Axiom 15: prefer type errors over prose rules, hooks over prompts, structure over instructions. |
| 2026-03-30 | Concentric gardening rings | Ring 0-2 code-enforced, Ring 3 code-triggered/prompt-executed, Ring 4 human. Push checks to inner rings. |
| 2026-03-30 | Graceful degradation | Axiom 16: no subsystem failure halts the pipeline. gc/metrics/sweep all best-effort. |
| 2026-03-30 | Scalable primitives | Axiom 17: every artifact has max size, archival trigger, retrieval path, owner. |
| 2026-03-30 | If it must happen, it's code | Axiom 18: type system > hooks > lint > tests > verify.sh > orchestrator > prompt > prose. |
| 2026-03-30 | Doc freshness as code check | verify.sh merge mode: warn if .ts changed but ARCHITECTURE.md didn't. Sweep creates task on repeated warnings. |
| 2026-03-30 | Pattern drift as code check | sweep-checks.ts: Result vs try/catch ratio, test coverage ratio, file size. Deterministic, no LLM. |
| 2026-03-30 | Every change is a migration | Axiom 19: additive-only by default. Breaking changes need versioning or migration. Agents see code, not history. |
| 2026-03-30 | Pre-merge blast radius review | Axiom 20: auto-generated inventory + diff cross-reference. Reviewer is not the change author. |
| 2026-03-30 | Closed-loop rule for code | No naked TODOs (must have task ID). No empty catches. No dead code. Enforce in lint. |
| 2026-03-30 | Session cap: 3 tasks or 100k tokens | Warm sessions degrade IQ per Axiom 14. Fresh session prevents context garbage. |
| 2026-03-30 | Error output truncation: 50+10 lines | Full test output tanks reasoning. First error is root cause. Truncate the rest. |
| 2026-03-30 | Codex hooks weaker than Claude hooks | Codex PreToolUse only fires on Bash, not file edits. Compensate with orchestrator-level scope check. |
| 2026-04-01 | Tests must run in parallel | jest --maxWorkers=100%. If tests can't run in parallel, the code has shared state — fix the code. |
| 2026-04-01 | Test isolation rules | No shared DB, files, ports, env vars, mocks. mkdtemp, port 0, in-memory DB, restoreAllMocks. |
| 2026-04-01 | Agent parallelism via interfaces | Types first as coordination contract. One agent = one concern = distinct files. Model matching per task. |
