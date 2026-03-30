# agentloop — Phase 2 handoff

Read AGENTS.md and ARCHITECTURE.md first. The architecture has been
significantly updated. This is the second phase of features, to be
implemented AFTER phase 1 (worktrees, slash commands, init, feature
gates, servicing loops) is complete.

Implement in order. Run ./verify.sh after each change.

---

## 1. Metrics logging

Add observability so we know if the system is working.

### 1a. Add metrics.jsonl logging
After every task completes (success or stuck), append one JSON line to
.agentloop/metrics.jsonl:

    {"task":"add cancel endpoint","rounds":2,"time_sec":240,"review_findings":1,
     "outcome":"merged","errors":["missing_validation"],"files":["cancel.service.ts"],
     "timestamp":"2026-03-29T12:00:00Z"}

Outcome values: "merged", "stuck", "blocked", "needs-human".
All four must be handled by the /metrics slash command and CLI.
Rule: log ONE row per task at its terminal state. If a task goes
blocked → later unblocked → merged, log only the final "merged" row.
Do not log intermediate state transitions.

Add this to the finalizer (not the task loop) — log once when the task
reaches a terminal state. Terminal states are:
- markDone in finalizer (outcome: "merged")
- markStuck in orchestrator.ts escalate path (outcome: "stuck")  
- markBlocked for debug tasks in orchestrator.ts (outcome: "needs-human")
- markBlocked for review conflicts in review-loop.ts (outcome: "blocked")

Create a shared `logMetrics(task, outcome, stats)` helper in a new
core/metrics.ts file. Call it from all four terminal paths — not just
the finalizer. Each call site already has access to the task and the
convergence state needed to populate the metrics line.
Simple fs.appendFile, no library needed.
The metrics line is summary-only. Full verify output is NOT stored
in metrics — it's only passed to the agent during fix rounds (truncated
per task 7c).

### 1b. Add /metrics slash command
Create .claude/commands/metrics.md:
Read .agentloop/metrics.jsonl. Compute and summarize conversationally:
- Average rounds per task (last 7 days)
- Average time per task
- First-pass clean rate (% of tasks with rounds=1)
- Stuck rate (% with outcome=stuck)
- Most common error type
- Trend vs previous 7 days (improving or degrading)

Update src/core/init.ts scaffoldRepo() to include this command
in the set of slash commands copied to target repos on init.

### 1c. Add `agentloop metrics` CLI command
Same output as the slash command but to stdout.

Note: metrics.jsonl rotation is handled by the GC pass in task 7a.
Task 1 only sets up append-only logging.

---

## 2. Test-first scaffolding in planning phase

Update the planning step so Claude (PM) produces not just a task
description but a complete scaffold:

### 2a. Add ScaffoldOutput type to types/domain.ts
    interface ScaffoldOutput {
      files: ScaffoldFile[];
    }
    type ScaffoldFile =
      | { type: 'types' | 'stub' | 'test'; path: string; content: string }
      | { type: 'golden-copy'; path: string; referencePath: string };

Golden-copy files have a referencePath pointing to the file to copy
from, not content. The orchestrator copies and renames the reference.

Also add 'NOT_IMPLEMENTED' to ErrorCode in src/shared/result.ts.

### 2b. Add scaffold generation to Claude adapter
Add a `scaffold(task: TaskDefinition): Promise<Result<ScaffoldOutput>>`
method to ClaudeAdapter. The prompt should ask Claude to produce:
- Function stubs with correct signatures and `return err('NOT_IMPLEMENTED', 'stub')`
  (NOT throw — the project bans exceptions, stubs must also use Result)
- Failing test file with specific test cases including edge cases
- For golden-copy type: identify the closest existing file to copy patterns
  from and set its path as referencePath in the ScaffoldFile union

### 2c. Update orchestrator to use scaffold
Before spawning the implementation agent, write scaffold files to the
worktree. The implementation agent sees: stubs + failing tests. It fills
in the function bodies until tests pass.

---

## 3. Progressive verify

Replace the single verify.sh call with staged verification.

### 3a. Add ProgressiveVerifier to core/verifier.ts
    async function progressiveVerify(
      config: AgentloopConfig, changedFiles: string[], cwd: string, mergeMode: boolean
    ): Promise<Result<VerifyResult>>
    
    Iteration mode (mergeMode=false):
      Stage 1: tsc --noEmit (incremental) — fail fast on type errors
      Stage 2: jest --findRelatedTests <changedFiles> — only related tests
    
    Merge mode (mergeMode=true):
      Stage 1 + 2 as above, plus:
      Stage 3: full test suite
      Stage 4: lint

All stages execute in the provided cwd (worktree directory).
Return on first failure. Don't run expensive stages if cheap ones fail.

### 3b. Update verify-loop.ts and task-runner.ts
Use progressiveVerify(mergeMode=false) during iteration.
Use progressiveVerify(mergeMode=true) before merge
(replace the existing runVerify call in src/core/task-runner.ts).

Threading changedFiles: the writer output (SessionOutput.changedFiles
or WriterOutput.changedFiles) must be passed through to verifyLoop().
Update verifyLoop() signature to accept `lastChangedFiles: string[]`.
On each fix round, update lastChangedFiles from the fix output.
Pass these to progressiveVerify for --findRelatedTests targeting.

### 3c. Update verify.sh template
Add a --progressive flag that runs the staged approach. Default (no flag)
runs everything for backward compatibility.

---

## 4. Four task types + research handler

### 4a. Add TaskType to types/domain.ts
    type TaskType = 'research' | 'implement' | 'integrate' | 'debug';

Add `type: TaskType` field to TaskDefinition. Default to 'implement'.
All existing task factories (interactive-task.ts, feature-docs.ts,
sweep.ts, finalizer.ts) that create tasks without specifying type
will get the default 'implement'. Add the default at the queue
normalization boundary (task-queue.ts add/ensureTask) so most callers
don't need updating. Exception: feature-docs.ts constructs TaskDefinition
outside the queue and passes it directly to Claude — this file must
be updated to include `type: 'implement'` explicitly.

Note: 'needs-human' is a metrics outcome only, NOT a TaskStatus.
In the code, debug tasks use status 'blocked' with a descriptive
reason. The metrics logger maps this to outcome 'needs-human' when
the task type is 'debug'.

### 4b. Update orchestrator.ts task routing
Different task types use different loops:
- research: Claude with web search + write tools, but scope limited to
  src/adapters/ and .agentloop/research/ only. Output is adapter interface
  + ARCHITECTURE.md decision row. No verify loop (no implementation to verify).
  Blocks before merge for human approval (see 4d).
- implement: Codex writes (via CodexWriterAdapter from task 8), full
  verify loop, shotgun eligible. The fast path.
- integrate: Codex writes, integration test suite (separate from unit tests),
  sequential only (no shotgun), careful mode.
- debug: Immediately escalate to Slack. Don't attempt. Log as "needs-human."

### 4c. Add integration test support to verifier
Support a separate integration test command (e.g. `npm run test:integration`)
that only runs for integrate-type tasks. Add `integrationTestCommand` to
AgentloopConfig.

### 4d. Research task handler
When task type is 'research':
1. Claude reads the task description + ARCHITECTURE.md
2. Claude searches the web for relevant packages/APIs
3. Claude produces: an adapter interface file + notes on the choice
4. Output is committed to the branch
5. Human reviews the interface (Slack notification)

Implementation notes:
- Add 'WebSearch' to the allowed tools list for research sessions in
  claude.ts (current read-only mode only has Read, Grep, Glob).
- Research tasks bypass the Codex requirement check in deps.ts and
  orchestrator.ts — they only use Claude, no Codex review needed.
- Research tasks skip the verify loop (no code to verify).
- Research tasks MUST block before merge: after committing the interface
  file and research notes, set task status to 'blocked' with reason
  "awaiting human approval of research output" and notify via Slack.
  
  To resume: extend the existing approveBlocked in task-queue.ts to
  handle non-finalization blocked tasks. Currently it only works for
  finalization-blocked tasks and errors otherwise. Modify it to:
  - For finalization-blocked: existing behavior (continue finalization)
  - For research-blocked: transition to 'merging' status (not 'queued'),
    since the research output is already committed on the branch. This
    skips re-running the task and goes straight to merge.
  - For other blocked: requeue to 'queued' with round:0 (restart)
  
  Also create .claude/commands/approve.md:
  ```
  Read tasks.json. Show all blocked tasks with their reasons.
  Ask the user which task to approve. Call requeueBlocked for that task.
  ```
  Update src/core/init.ts to scaffold this command on init.

Research output format:
    src/adapters/payment.adapter.ts (interface only, no implementation)
    .agentloop/research/payment-decision.md (detailed notes on the choice)
    ARCHITECTURE.md decisions table (one-line decision row added)

The interface becomes the contract that implementation tasks build against.
Research decision files are archived when the feature merges (GC pass).
The ARCHITECTURE.md row persists as the permanent record of the decision.

---

## 5. Parallel test architecture enforcement

### 5a. Add to AGENTS.md template (templates/AGENTS.md)
Under conventions, add:
- Every test creates its own dependencies. No shared mutable state.
- Tests must pass in any order and in parallel (jest maxWorkers=100%).
- Pure functions only in service files. Side effects isolated in adapters.
- No singletons. Pass dependencies as function arguments.
- Time via dependency injection: never use Date.now() directly.

### 5b. Add to verify.sh template
Add jest --maxWorkers=100% to the test command. Tests that fail in
parallel mode have hidden shared state — this is the forcing function.

### 5c. Create tsconfig template
Create templates/tsconfig.json with "incremental": true and
"tsBuildInfoFile": ".tsbuildinfo" for fast type checking.
Update src/core/init.ts scaffoldRepo() to copy this template
into target repos on init (skip if tsconfig.json already exists).

---

## Implementation order

1 first (metrics — know where you are before optimizing).
Then 7 (garbage collection — prevent leaks before adding features).
Then 8 (Codex as writer — fundamental model role change, needed by task 4).
Then 3 (progressive verify — biggest speed win, lowest risk).
Then 5 (parallel test enforcement — enables everything else).
Then 2 (test-first scaffolding — biggest correctness win).
Then 4 (task types + research handler — structural change, do last).
Then 9 (self-evolving AGENTS.md — learning system, do after metrics data exists).

After each change: run ./verify.sh.
After each group: review against ARCHITECTURE.md.

---

## 7. Garbage collection and closed-loop enforcement

### 7a. Finalizer GC pass
Add a garbage collection step to core/finalizer.ts that runs after
every successful merge:

- Delete the task's worktree directory (rm -rf the worktree path)
- Delete any orphaned base worktrees under _base/ that have no
  corresponding active task branch
- Delete the merged al/ branch (git branch -d)
- Prune notification keys older than 7 days from notifications.json.
  Note: current format is bare string[]. Migrate to [{key, createdAt}]
  so age-based pruning works. Backward-compat: if file contains bare
  string[], treat all entries as undated, skip pruning until next write.
- Archive completed/stuck tasks older than 30 days from tasks.json
  (move to .agentloop/archive.jsonl, remove from tasks.json)
- Force-remove stale .lock directories older than 5 minutes
- Rotate metrics.jsonl: if file is older than 90 days, archive to
  .agentloop/metrics-archive/ with date suffix, start fresh file
- Clean up temp files (tasks.json.*.tmp, notifications.json.tmp)
- Remove smart-init artifacts (.agentloop/drafts/, init-questions.json,
  coverage.json) if init has completed
- Archive .agentloop/research/*.md when the associated feature merges
  (move to .agentloop/archive/ or delete)
- Evict completed sessions from the in-memory Claude session Map

Add a `gc()` function to finalizer.ts. Call it at the end of
the finalize() function after markDone. GC is best-effort: if any
cleanup step fails, log the error but do NOT fail the task or
return an error Result. The task is already done — GC failure
should not undo a successful merge.

### 7b. Session context limits
Add to AgentloopConfig:
    maxTasksPerSession: number;    // default: 3
    maxTokensPerSession: number;   // default: 100000

Update the orchestrator: add a cumulative token counter that persists
across tasks within the same session. After each task, add the task's
tokenEstimate (from WriterOutput) to the counter. For Claude sessions
this is exact; for Codex sessions this may be 0 — in that case, count
by tasks only (maxTasksPerSession). When either limit is reached,
set a flag to start a fresh session for the next task (reset counter,
clear stored session).

Note: task 7b runs before task 8 in the implementation order. Initially
use the existing SessionOutput.tokensDelta field. When task 8 migrates
to WriterOutput.tokenEstimate, update the counter to use the new field.

### 7c. Error output truncation
Update core/verifier.ts: when verify output exceeds 100 lines,
truncate to first 50 lines + "... (truncated) ..." + last 10 lines.
This truncation applies ONLY to the output passed back to the agent
for fixing (the fix prompt). It does NOT apply to:
- The metrics.jsonl log (which stores summary error types, not raw output)
- The verify Result returned to the orchestrator (which keeps full output
  for convergence hash computation)

### 7d. Sweep task deduplication
Update core/sweep.ts: before adding a proposed task, hash its title
and check against existing tasks. Skip duplicates. Cap sweep-generated
tasks at 10 in the queue.

Note: current queue interface doesn't expose dedupeKey (it's internal
to task-queue.ts, stripped by the list() method). Add a
`countByDedupePrefix(prefix: string): Promise<Result<number>>` method
to TaskQueueAdapter that counts tasks whose dedupeKey starts with the
given prefix. Use prefix "sweep:" for sweep tasks. This avoids exposing
the full dedupeKey while enabling the cap check.

### 7e. Code garbage lint rules
Update the templates/verify.sh template to include:

    # Fail on naked TODOs/FIXMEs/HACKs without task IDs
    # Set AGENTLOOP_PREFIX env var in .claude/settings.json or .codex/hooks.json
    # Default prefix is "al-" if not set
    PREFIX="${AGENTLOOP_PREFIX:-al-}"
    if grep -rn 'TODO\|FIXME\|HACK' src/ \
      | grep -v "TODO(${PREFIX}" \
      | grep -v "FIXME(${PREFIX}" \
      | grep -v "HACK(${PREFIX}" \
      | grep -v node_modules; then
      echo "ERROR: Found TODO/FIXME/HACK without task ID. Use: // TODO(${PREFIX}NNN): description"
      exit 1
    fi

Add ESLint rule recommendations to the templates/AGENTS.md:
- no-unused-vars: error
- no-empty (catch blocks): error
- no-console: error
- @typescript-eslint/no-unused-imports: error

Also add to verify.sh template (merge-time only checks):
- depcheck for unused packages: `npx depcheck --ignores="@types/*" || exit 1`
- eslint-plugin-no-commented-out-code or grep-based equivalent:
  `grep -rn '^\s*//.*[{(;]' src/ | grep -v 'TODO\|FIXME\|HACK\|NOTE\|eslint' && echo "ERROR: commented-out code found" && exit 1`

These run on merge only (not during iteration) to avoid slowing the loop.

### 7f. Stale lock detection
Update the withLock functions in core/task-queue.ts and core/notifier.ts:
before the retry loop, check if the .lock directory is older than 5
minutes (stat the directory mtime). If stale, force-remove it and
proceed. This prevents crashed processes from permanently blocking
the queue.

---

## 8. Codex as implementation agent

The model roles decision (Claude = PM, Codex = engineer) requires Codex
to write code, not just review it. The current codebase only calls Codex
via the OpenAI chat API for review. This task adds Codex as the writing
agent.

### 8a. Add WriterOutput type and Codex CLI adapter
First, add a WriterOutput type to types/adapters.ts that both Claude
and Codex adapters can return:

    interface WriterOutput {
      text: string;
      changedFiles: string[];
      tokenEstimate: number;     // 0 if unknown (Codex CLI), exact from Claude
    }

This replaces SessionOutput for write/fix operations. SessionOutput
has Claude-specific fields (stopReason with hook semantics, tokensDelta
from Claude usage API) that Codex CLI cannot produce. The `success`
field is omitted because it's redundant with the Result wrapper.
Update all write/fix call sites in task-runner.ts, verify-loop.ts,
and review-loop.ts to use WriterOutput instead of SessionOutput.

Also remove or demote ModelPreference from TaskDefinition in
types/domain.ts — TaskType now determines which model writes.
ModelPreference can stay as an optional override hint but should
not be required.

Then create core/codex-writer.ts implementing CodexWriterAdapter:

    interface CodexWriterAdapter {
      write(prompt: string, cwd: string): Promise<Result<WriterOutput>>;
      fix(prompt: string, cwd: string): Promise<Result<WriterOutput>>;
    }

Use Codex CLI in non-interactive (full-auto) mode:
    codex --full-auto --quiet -m <model> "<prompt>"

Parse exit code and stdout for results. Derive changedFiles from
git diff after session completes. Codex CLI reads AGENTS.md
from the working directory automatically.

### 8b. Add orchestrator-level scope check for Codex
After each Codex write session stops, check the git diff for
out-of-scope files. If any file outside task.scope.editableFiles was
modified, revert those specific files and log a warning. This
compensates for Codex hooks not intercepting file edits (only Bash).

Add a `checkScope(diff: string, scope: TaskScope): Result<string[]>`
function to a new core/scope.ts file. Returns an empty array if all
changes are in scope, or a list of out-of-scope file paths. The
orchestrator calls revertFiles() with the returned paths if non-empty.
Call it after Codex write/fix sessions return.

Also add a `revertFiles(paths: string[]): Promise<Result<void>>`
method to GitAdapter (git checkout -- <paths>). This is needed to
surgically revert out-of-scope changes without losing in-scope work.

### 8c. Wire Codex writer adapter into orchestrator
Add CodexWriterAdapter to the Deps interface and create it in deps.ts.
For now, do NOT add TaskType-based routing (TaskType doesn't exist yet —
that comes in task 4). Instead, make the writer adapter configurable:
add `useCodexWriter: boolean` to AgentloopConfig (default: false).
When true, the orchestrator uses CodexWriterAdapter for write/fix.
When false, it uses ClaudeAdapter (current behavior). This lets you
test the Codex writer before task 4 adds full task-type routing.

Task 4b will later replace this boolean with TaskType-based routing:
implement → Codex, research → Claude, etc.

Also update claude.fix() calls in verify-loop.ts and review-loop.ts:
when useCodexWriter is true, use codexWriter.fix() instead.

For research-type tasks (once task 4 exists):
- Continue using ClaudeAdapter for everything (Claude does research)

### 8d. Configure Codex hooks in target repos
Create templates/codex-hooks.json with Stop hook for verify and
SessionStart for context injection. Add a companion
templates/CODEX_HOOKS_README.md documenting that PreToolUse only fires
on Bash today and scope enforcement is orchestrator-level (JSON doesn't
support comments).

Update src/core/init.ts scaffoldRepo() to copy codex-hooks.json
into .codex/hooks.json alongside .claude/settings.json on init.

### 8e. Convert parallel reviews to sequential
Replace the current runParallelReviews() in src/core/review-loop.ts
with sequential flow:
1. Codex self-review via existing CodexAdapter (chat API) — detail/correctness
2. Claude final sweep via ClaudeAdapter.review() — architecture coherence
3. Merge findings from both, then fix

Also update src/core/feature-gate.ts to use the same sequential flow.

This matches ARCHITECTURE.md: "Codex writes → Codex self-reviews →
Claude final sweep." The parallel approach was the earlier design.
The sequential approach ensures Codex reviews its own work first
(catching detail issues) before Claude checks architectural fit.

---

## 9. Self-evolving AGENTS.md

### 9a. Error log aggregation and learnings.json
After every task, the metrics.jsonl entry already logs error types.
Add a core/learnings.ts module that:
1. Reads the last 20 entries from metrics.jsonl
2. Counts error type frequencies
3. Groups by file/module to identify hotspots
4. Compares against current learnings.json
5. Updates learnings.json (max 10 entries, least-triggered pruned)

Schema for learnings.json:
    [{ "pattern": "missing ID validation", "module": "orders",
       "count": 7, "lastSeen": "2026-03-30", "suggestion": "..." }]

Store at .agentloop/learnings.json.

### 9b. Learnings injection into task prompts
When the orchestrator prepares a task prompt (in task-runner.ts or
the Codex writer adapter), read learnings.json and inject the 2-3
entries whose `module` matches the task's editableFiles. Inject as
a short addendum to the prompt, not into AGENTS.md:

    "Common mistakes in this area:
     - Missing ID validation (seen 7 times)
     - Forgetting updatedAt timestamp"

This costs minimal context tokens (2-3 lines) and targets only
relevant learnings. If no learnings match the task's files, inject
nothing.

### 9c. Proposal generation
Every 20 tasks, trigger a proposal. Track the count by reading the
total line count of metrics.jsonl modulo 20 (derived, not stored —
survives restarts without separate state). When count hits a multiple
of 20:
1. Read metrics.jsonl last 20 entries + current AGENTS.md
2. Claude generates proposed AGENTS.md edits as a diff
3. For each proposed rule, check: can this be a lint rule, test helper,
   or type constraint instead of prose? If yes, propose that instead.
4. Write proposal to .agentloop/proposed-agents-update.md
5. Slack notification: "AGENTS.md update proposed. Review in repo."

### 9d. Human approval gate
The proposal is NOT auto-applied. Human reviews the diff in Conductor
or via the /review-agents-update slash command. Approve = applied.
Reject = discarded. This ensures AGENTS.md stays human-curated.

Create .claude/commands/review-agents-update.md:
```
Read .agentloop/proposed-agents-update.md. Show the proposed changes
as a diff against current AGENTS.md. Ask the user to approve or reject.
If approved, apply the changes to AGENTS.md and delete the proposal file.
If rejected, delete the proposal file.
```

Also update src/core/init.ts to include this command in the scaffolded
slash commands.

Cap: AGENTS.md must stay under 100 lines after the update. If the
proposal would exceed 100 lines, the least-valuable existing rule
must be removed to make room.

---

After each change: run ./verify.sh.
After each group: review against ARCHITECTURE.md.
