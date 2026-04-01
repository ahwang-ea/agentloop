// core/claude.ts — Claude Agent SDK adapter wiring.

import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, ClaudeAdapter, ClaudeSession, WriterOutput } from '../types/index.js';
import {
  createOrReuseClaudeSession,
  evictClaudeTaskSessions,
  getClaudeSession,
  type StoredSession,
} from './claude-session-store.js';
import { runClaudeTurn } from './claude-turn.js';
import { buildReviewPrompt, parseReviewOutput } from './review-output.js';
import { elapsedSeconds, systemRuntime, type RuntimeDeps } from './runtime.js';
import { buildScaffoldPrompt, parseScaffoldOutput } from './scaffold.js';
import { cleanupPrompt, buildWritePrompt } from './writer-prompt.js';

const WRITE_TIMEOUT_MS = 180_000;
const SCAFFOLD_TIMEOUT_MS = 60_000;
const REVIEW_TIMEOUT_MS = 60_000;
const CHAT_TIMEOUT_MS = 180_000;

export function createClaudeAdapter(config: AgentloopConfig, runtime: RuntimeDeps = systemRuntime): ClaudeAdapter {
  const sessions = new Map<string, StoredSession>();
  const runStoredTurn = async (stored: StoredSession, prompt: string): Promise<Result<WriterOutput>> => {
    const turn = await runClaudeTurn(config, stored.cwd, prompt, stored.resumeId, stored.mode, WRITE_TIMEOUT_MS, runtime);
    if (!turn.ok) return turn;
    stored.resumeId = turn.value.sessionId;
    return ok({ text: turn.value.text, changedFiles: turn.value.changedFiles, tokenEstimate: turn.value.tokensDelta });
  };
  const runSessionTurn = async (session: ClaudeSession, prompt: string): Promise<Result<WriterOutput>> => {
    const stored = getClaudeSession(sessions, session);
    return stored.ok ? runStoredTurn(stored.value, prompt) : stored;
  };
  return {
    async startSession(task, cwd, reuse, prompt) {
      const initialPrompt = prompt ?? buildWritePrompt(task);
      return ok(createOrReuseClaudeSession(sessions, task, cwd, reuse, initialPrompt));
    },
    async waitForStop(session) {
      const stored = getClaudeSession(sessions, session);
      if (!stored.ok) return stored;
      if (!stored.value.initialPrompt) return err('SESSION_ERROR', `Claude session ${session.id} has no pending prompt`);
      const result = await runStoredTurn(stored.value, stored.value.initialPrompt);
      if (result.ok) stored.value.initialPrompt = '';
      return result;
    },
    fix: (session, errors) => runSessionTurn(session, `Address the following feedback, make the necessary edits, and stop when done:

${errors}`),
    cleanup: session => runSessionTurn(session, cleanupPrompt),
    async review(request) {
      const started = runtime.now();
      const turn = await runClaudeTurn(config, config.repoPath, buildReviewPrompt(request), undefined, 'prompt', REVIEW_TIMEOUT_MS, runtime);
      return turn.ok ? parseReviewOutput(turn.value.text, request.role, elapsedSeconds(runtime, started)) : turn;
    },
    async chat(message) {
      const turn = await runClaudeTurn(config, config.repoPath, message, undefined, 'prompt', CHAT_TIMEOUT_MS, runtime);
      return turn.ok ? ok({ text: turn.value.text, tokensDelta: turn.value.tokensDelta, changedFiles: turn.value.changedFiles, stopReason: turn.value.stopReason }) : turn;
    },
    async scaffold(task) {
      const turn = await runClaudeTurn(config, config.repoPath, buildScaffoldPrompt(task), undefined, 'readonly', SCAFFOLD_TIMEOUT_MS, runtime);
      return turn.ok ? parseScaffoldOutput(turn.value.text) : turn;
    },
    async evictTaskSessions(taskId) {
      evictClaudeTaskSessions(sessions, taskId);
      return ok(undefined);
    },
  };
}
