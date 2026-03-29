// orchestrator.ts — The core state machine.
// This file manages the full task pipeline.
// Each step is deterministic code, not an LLM deciding.

import type {
  AgentloopConfig,
  TaskDefinition,
  TaskState,
  ConvergenceState,
  ReviewFinding,
  BehaviorChange,
  ClaudeAdapter,
  CodexAdapter,
  GitAdapter,
  NotifierAdapter,
  TaskQueueAdapter,
} from './types.js';
import { ok, err, type Result } from './shared/result.js';
import { classifyConvergence, trackRound } from './core/convergence.js';
import { runVerify } from './core/verifier.js';
import { runParallelReviews, formatFixPrompt } from './core/reviewer.js';
import { detectBehaviorChanges } from './core/behavior.js';

interface OrchestratorDeps {
  claude: ClaudeAdapter;
  codex: CodexAdapter;
  git: GitAdapter;
  notifier: NotifierAdapter;
  queue: TaskQueueAdapter;
  config: AgentloopConfig;
}

export async function runOrchestrator(deps: OrchestratorDeps): Promise<void> {
  const { claude, codex, git, notifier, queue, config } = deps;
  let tasksSinceSweep = 0;

  while (true) {
    // --- Pick task ---
    const nextTask = await queue.next();
    if (!nextTask.ok) break;
    if (nextTask.value === null) {
      // Queue empty — trigger architect sweep to propose work
      await notifier.send({
        type: 'sweep-result',
        summary: 'Task queue empty. Architect sweep needed.',
        details: 'No tasks remaining. Review ARCHITECTURE.md for next priorities.',
        timestamp: new Date(),
      });
      break;
    }

    const task = nextTask.value;
    const branchName = `task/${task.id}-${slugify(task.title)}`;

    // --- Create branch ---
    const branch = await git.createBranch(branchName);
    if (!branch.ok) { await escalate(deps, task, branch.error); continue; }

    // --- Write + Verify loop (Loop 1) ---
    const writeResult = await writeLoop(deps, task);
    if (!writeResult.ok) { await escalate(deps, task, writeResult.error); continue; }

    // --- Cross-model review (Loop 2) ---
    const reviewResult = await reviewLoop(deps, task);
    if (!reviewResult.ok) { await escalate(deps, task, reviewResult.error); continue; }

    // --- Cleanup pass ---
    await claude.cleanup();
    const cleanupVerify = await runVerify(config.verifyCommand);
    if (!cleanupVerify.ok || !cleanupVerify.value.pass) {
      // Cleanup broke something — one more fix round
      await claude.fix(cleanupVerify.ok ? cleanupVerify.value.output : 'Verify failed after cleanup');
      await runVerify(config.verifyCommand);
    }

    // --- Merge ---
    await git.commit(`feat: ${task.title}`);
    const diff = await git.getDiff('main');
    await git.merge(branchName);
    await git.rebaseAll(branchName);

    // --- Behavior check ---
    if (diff.ok) {
      const behavior = detectBehaviorChanges(diff.value);
      if (behavior.hasChanges) {
        await notifier.send({
          type: 'behavior-change',
          taskId: task.id,
          summary: behavior.changes.map(c => c.description).join('\n'),
          details: `Files: ${behavior.changes.flatMap(c => c.files).join(', ')}`,
          timestamp: new Date(),
        });
        // Auto-create README update task
        if (behavior.readmeUpdateNeeded) {
          await queue.add({
            title: `Update README for ${task.title}`,
            description: `Behavior changes: ${behavior.changes.map(c => c.description).join('; ')}. Update README.md to reflect these changes.`,
            scope: { editableFiles: ['README.md'], readOnlyContext: [], forbiddenFiles: [] },
            acceptanceCriteria: ['README reflects current behavior'],
            model: 'auto',
            priority: 'medium',
          });
        }
      }
    }

    await queue.markDone(task.id);
    tasksSinceSweep++;

    // --- Periodic sweep ---
    if (tasksSinceSweep >= config.sweepInterval) {
      tasksSinceSweep = 0;
      await architectSweep(deps);
    }
  }
}

// --- Write Loop: agent writes, verify runs, retry on failure ---
async function writeLoop(deps: OrchestratorDeps, task: TaskDefinition): Promise<Result<void>> {
  const { claude, config } = deps;
  const convergence: ConvergenceState = { rounds: [], classification: 'unknown', webSearchTriggered: false };
  const startTime = Date.now();

  // Initial write
  await claude.write(task.description, task.scope);

  while (true) {
    const verify = await runVerify(config.verifyCommand);
    if (!verify.ok) return err(verify.error);

    const round = trackRound(convergence, verify.value);
    const elapsed = (Date.now() - startTime) / 1000;

    if (verify.value.pass) return ok(undefined);

    // Budget check
    if (elapsed > config.convergence.maxWallClock) return err(`Budget exceeded after ${round} rounds`);

    // Convergence classification
    const classification = classifyConvergence(convergence, config.convergence);
    convergence.classification = classification;

    if (classification === 'stuck') return err(`Stuck: same error ${config.convergence.stuckThreshold} rounds`);
    if (classification === 'thrashing') return err('Thrashing: errors oscillating');

    // Web search trigger: same error twice → search before third attempt
    if (shouldWebSearch(convergence) && !convergence.webSearchTriggered) {
      convergence.webSearchTriggered = true;
      await claude.fix(`Search for this error, then fix based on what you find:\n${verify.value.errors[0]?.message}`);
    } else {
      await claude.fix(verify.value.output);
    }
  }
}

// --- Review Loop: parallel Opus + Codex reviews ---
async function reviewLoop(deps: OrchestratorDeps, task: TaskDefinition): Promise<Result<void>> {
  const { claude, codex, git, config } = deps;

  const diff = await git.getDiff('main');
  if (!diff.ok) return err(diff.error);

  const reviews = await runParallelReviews(deps, task, diff.value);
  if (!reviews.ok) return err(reviews.error);

  const allFindings = reviews.value.flatMap(r => r.findings);
  if (allFindings.length === 0) return ok(undefined);

  // Fix findings
  const fixPrompt = formatFixPrompt(allFindings);
  await claude.fix(fixPrompt);

  // Re-verify after fixes
  const reVerify = await runVerify(config.verifyCommand);
  if (!reVerify.ok || !reVerify.value.pass) {
    // One more attempt
    await claude.fix(reVerify.ok ? reVerify.value.output : 'Verify failed after review fixes');
    await runVerify(config.verifyCommand);
  }

  return ok(undefined);
}

// --- Helpers ---
async function escalate(deps: OrchestratorDeps, task: TaskDefinition, reason: string): Promise<void> {
  await deps.queue.markStuck(task.id, reason);
  await deps.notifier.send({
    type: 'escalation',
    taskId: task.id,
    summary: `Stuck: ${task.title}`,
    details: reason,
    timestamp: new Date(),
  });
}

async function architectSweep(deps: OrchestratorDeps): Promise<void> {
  // TODO: Implement sweep — read ARCHITECTURE.md, check file sizes,
  // check for unplanned deps, check shared type consistency.
  // For now, just notify that a sweep is due.
  await deps.notifier.send({
    type: 'sweep-result',
    summary: 'Architect sweep due',
    details: 'Manual review of codebase vs ARCHITECTURE.md recommended.',
    timestamp: new Date(),
  });
}

function shouldWebSearch(convergence: ConvergenceState): boolean {
  const rounds = convergence.rounds;
  if (rounds.length < 2) return false;
  const current = rounds[rounds.length - 1];
  const prev = rounds[rounds.length - 2];
  // Same first error two rounds in a row
  return current.issueHashes.length > 0 &&
    prev.issueHashes.length > 0 &&
    current.issueHashes[0] === prev.issueHashes[0];
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
}
