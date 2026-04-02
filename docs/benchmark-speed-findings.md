# CRM Benchmark Speed Optimization Findings

**Date**: 2026-04-02
**Baseline**: Score 1.0, 22m 32s (5 tasks, xhigh effort, depth-3 plan)
**Best result**: Score 1.0, 10m 38s (5 tasks, high effort, depth-2 flat plan, 4-way race)
**Improvement**: 53% wall time reduction

---

## What worked

### 1. Multi-attempt racing (biggest single win)
Run 4 parallel orchestrator attempts, each bootstrapping its own repo with an independent LLM-generated plan. First to score > 0 wins. The non-deterministic nature of plan generation provides natural variance — different plans have different task decompositions, and the luckiest one finishes significantly faster than average.

**Implementation**: `runBenchmarkSuite()` spawns N `runSingleAttempt()` calls with staggered starts (3s apart). A promise race resolves on the first `score > 0`.

**Why it works**: Turns LLM variance from a liability into an asset. Instead of optimizing one attempt, we exploit the favorable left tail of the completion time distribution.

### 2. Depth-2 dependency flattening (`flattenPlan()`)
Mechanically rewrites all task dependencies so task[0] has no deps and all remaining tasks depend only on task[0]. This ensures maximum parallelism: foundation runs first, then everything else simultaneously.

**Key insight**: The planner LLM consistently ignored prompt instructions like "depth MUST be 2". Mechanical enforcement in code (principle: code > prompts) was the only reliable way to guarantee flat dependencies.

**Implementation**: 10-line function in `planner-generate.ts` that remaps `dependsOn` arrays post-generation.

### 3. Codex reasoning effort = `high` (not `xhigh`)
SWE-bench data showed diminishing returns:
- medium→high: +0.3% accuracy for +168s latency
- high→xhigh: +2.1% accuracy for +551s latency

`high` is the sweet spot — fast enough to win races, accurate enough for CRM-complexity tasks. Combined with racing, the occasional failure is compensated by other attempts.

### 4. Better prompts for first-pass success
Added specific guidance about common failure patterns:
- better-sqlite3 row typing: `cast .get() as RowType | undefined`
- Row type interfaces with snake_case fields
- These target the #1 cause of fix rounds (TypeScript `unknown`/`{}` type errors)

### 5. Skip non-essential phases
- `skipCleanup: true` — saves one Claude API call per task
- `reviewEnabled: false` — saves two review calls (Opus + Codex) per task
- `sweepInterval: 0` — no periodic architecture sweeps
- Scaffold timeout 60s → 30s — faster planning worker

### 6. Increased parallelism
- `maxParallelAgents: 5` (was 2) — 5 concurrent task workers
- Planner prompt enforces exclusive file ownership per task — no merge conflicts

---

## What didn't work

### 1. Claude as writer (useCodexWriter: false)
**Result**: Score 0, all tasks stuck at r=0
**Why**: Claude Agent SDK sessions have 180s timeout, high per-session overhead, and don't handle multi-file creation well. Codex CLI is purpose-built for autonomous file editing with sandbox, process isolation, and no session overhead.

### 2. Medium reasoning effort
**Result**: Score 0, all tasks produced empty/placeholder code
**Why**: Codex at medium effort doesn't think hard enough to actually generate complete implementations. It produces stubs or empty files. The gap between medium (55.3%) and high (55.6%) accuracy on SWE-bench masks a qualitative difference: medium often produces *nothing*, not just *wrong code*.

### 3. Shotgun execution (multiple variants per task)
**Result**: Score 0, git worktree conflicts during finalization
**Why**: When variant-1 creates untracked files that conflict with variant-2's worktree, `git rebase` fails with "untracked working tree files would be overwritten". The shotgun implementation doesn't fully isolate variant worktrees during finalization.

### 4. `effort: 'max'` on Claude planning
**Result**: Planning step timed out at 180s
**Why**: Max effort with adaptive thinking on Claude Opus makes the planning chat take too long. Planning is a simple structured output task — it doesn't benefit from deep reasoning.

---

## Key data

### Per-task timing comparison (Score 1.0 runs)

| Task | 22m baseline (xhigh) | 15m winner (high) | 10m winner (high) |
|------|---------------------|-------------------|-------------------|
| Foundation | 265s | 146s | 175s |
| Entity 1 | 465s | 366s | 285s |
| Entity 2 | 518s | 526s | 394s |
| Entity 3 | 518s | 615s | 406s |
| App wiring | 512s | 716s | 324s |
| **Wall clock** | **1352s** | **909s** | **638s** |

### Effort level performance (SWE-bench reference)

| Effort | Latency | SWE-bench accuracy | Notes |
|--------|---------|-------------------|-------|
| none | 117s | 47.3% | Not tested in benchmark |
| low | 171s | 51.2% | Not tested in benchmark |
| medium | 334s | 55.3% | **Failed** — empty output |
| high | 502s | 55.6% | **Sweet spot** — fast + accurate |
| xhigh | 1053s | 57.7% | Reliable but 2x slower |

### Race outcomes (4-way race, latest run)

| Attempt | Effort | Writer | Score | Duration |
|---------|--------|--------|-------|----------|
| 0 | high | codex | 0.3 | — |
| 1 | high | codex | **1.0** | **10m38s** |
| 2 | high | codex | 0.6 | — |
| 3 | xhigh | codex | 0.6 | — |

---

## Principles for AI agent engineering

1. **Speculative racing > single-path optimization**: Run N attempts, take the winner. Variance is your friend.
2. **Mechanical enforcement > prompt engineering**: Code guarantees beat LLM instructions (flattenPlan vs "depth MUST be 2").
3. **More agents = more tokens/s**: Wall time is bounded by critical path depth × per-task time. Maximize useful parallel work.
4. **First-pass success rate is the dominant variable**: A fix round costs as much as the initial write. Better prompts > faster models.
5. **Diminishing returns on reasoning effort**: high is 2x faster than xhigh for 2% less accuracy. Race compensates.
6. **Skip everything non-essential**: Review, cleanup, deep scaffolding — if it's not in the critical path, remove it.
7. **Task scope controls speed**: 2-3 files per task completes in 300s. 5+ files takes 500s+. Smaller is faster.
8. **File exclusivity prevents conflicts**: No two tasks should write the same file. Barrel files (index.ts) are a merge conflict magnet.

---

## Next experiments to try

1. **Micro-task decomposition**: Break into 15-20 single-file tasks, run 15+ parallel agents. Expected critical path: foundation(120s) + single-file(90s) = ~4 min.
2. **Speculative task writing**: Start entity tasks writing before foundation merges. Codex doesn't need compiled deps to write code — only verify does.
3. **Fix shotgun execution**: Isolate variant worktrees during finalization to prevent git conflicts. Then combine shotgun + high effort for per-task redundancy.
4. **Adaptive effort escalation**: Start at medium, escalate to high on failure. Need to fix medium's empty-output problem first (possibly a prompt issue).
5. **Increase race count to 6-8**: More attempts = higher P(fast winner). Diminishing returns beyond ~5 but cheap if API rate limits allow.
6. **Cache npm install**: Bootstrap repos share the same deps. Pre-install to a shared location and symlink.
