// core/claude.ts — Claude Agent SDK adapter implementation.

import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, ClaudeAdapter, ClaudeSession, SessionOutput, WriterOutput } from '../types/index.js';
import { buildReviewPrompt, parseReviewOutput } from './review-output.js';
import { buildScaffoldPrompt, parseScaffoldOutput } from './scaffold.js';
import { cleanupPrompt, buildWritePrompt } from './writer-prompt.js';

type ToolMode = 'readonly' | 'write' | 'research' | 'prompt';
interface StoredSession { initialPrompt: string; resumeId?: string; cwd: string; taskId: string; mode: Exclude<ToolMode, 'readonly' | 'prompt'>; }
interface TurnResult extends SessionOutput { sessionId: string; }
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const RESEARCH_TOOLS = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'MultiEdit', 'Bash', 'WebSearch'];
const appEnv = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'agentloop/0.1.0' };
const tokenCount = (usage: unknown) => ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
  .reduce((sum, key) => sum + (typeof (usage as Record<string, unknown> | null)?.[key] === 'number' ? Number((usage as Record<string, unknown>)[key]) : 0), 0);
const stopReason = (raw: string | null, sawHook: boolean): SessionOutput['stopReason'] => sawHook
  ? 'stop_hook' : raw === 'max_tokens' ? 'max_tokens' : raw === 'tool_use' ? 'tool_use' : 'end_turn';
const tools = (mode: ToolMode): string[] | { type: 'preset'; preset: 'claude_code' } => mode === 'write' ? { type: 'preset', preset: 'claude_code' } : mode === 'research' ? RESEARCH_TOOLS : mode === 'prompt' ? [] : READ_ONLY_TOOLS;
const agentic = (mode: ToolMode) => mode === 'write' || mode === 'research';
const READ_ONLY_TURNS = 10;
const WRITE_TURNS = 40;
const WRITE_TIMEOUT_MS = 180_000;
const SCAFFOLD_TIMEOUT_MS = 60_000;
const REVIEW_TIMEOUT_MS = 60_000;
const CHAT_TIMEOUT_MS = 180_000;
const TRANSIENT_RETRY_MS = 1_000;
const transient = (text: string) => /(?:repeated\s+529|\b529\b.*overloaded|api error:|rate limit|temporarily unavailable)/i.test(text);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function runTurn(
  config: AgentloopConfig, cwd: string, prompt: string, resume: string | undefined, mode: ToolMode, timeoutMs?: number,
): Promise<Result<TurnResult>> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let retry = false, hookStop = false, sessionId = resume ?? '';
    const changedFiles = new Set<string>(), abortController = new AbortController();
    const timer = timeoutMs ? setTimeout(() => abortController.abort(), timeoutMs) : undefined;
    try {
      for await (const message of query({ prompt, options: { abortController, cwd, env: appEnv, maxTurns: agentic(mode) ? WRITE_TURNS : READ_ONLY_TURNS, model: config.claudeModel, permissionMode: agentic(mode) ? 'acceptEdits' : 'dontAsk', settingSources: agentic(mode) ? ['project'] : undefined, tools: tools(mode), resume } })) {
        if (message.type === 'system' && message.subtype === 'files_persisted') message.files.forEach(file => changedFiles.add(file.filename));
        if (message.type === 'system' && message.subtype === 'hook_response' && message.hook_event === 'Stop') hookStop = true;
        if (message.type !== 'result') continue;
        sessionId = message.session_id;
        const tokensDelta = tokenCount(message.usage);
        if (message.subtype !== 'success') {
          const reason = message.errors.join('\n') || 'Claude query failed';
          if (attempt < 4 && transient(reason)) { retry = true; break; }
          return err('SESSION_ERROR', reason, { sessionId });
        }
        if (transient(message.result)) {
          if (attempt < 4) { retry = true; break; }
          return err('SESSION_ERROR', message.result, { sessionId });
        }
        return ok({ text: message.result, tokensDelta, changedFiles: [...changedFiles], stopReason: stopReason(message.stop_reason, hookStop), sessionId });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown error';
      if (abortController.signal.aborted && timeoutMs) return err('BUDGET_EXCEEDED', `Claude ${mode} timed out after ${Math.round(timeoutMs / 1000)}s`);
      if (attempt < 4 && transient(message)) retry = true;
      else return err('SESSION_ERROR', `Claude query failed: ${message}`);
    } finally { if (timer) clearTimeout(timer); }
    if (!retry) return err('EMPTY_RESPONSE', 'Claude query returned no result');
    await pause(TRANSIENT_RETRY_MS * (attempt + 1));
  }
  return err('SESSION_ERROR', 'Claude query hit repeated transient API errors');
}

export function createClaudeAdapter(config: AgentloopConfig): ClaudeAdapter {
  const sessions = new Map<string, StoredSession>();
  const runSessionTurn = async (session: ClaudeSession, prompt: string): Promise<Result<WriterOutput>> => {
    const stored = sessions.get(session.id); if (!stored) return err('SESSION_ERROR', `Unknown Claude session ${session.id}`);
    const timeout = stored.mode === 'write' || stored.mode === 'research' ? WRITE_TIMEOUT_MS : undefined;
    const turn = await runTurn(config, stored.cwd, prompt, stored.resumeId, stored.mode, timeout); if (!turn.ok) return turn;
    stored.resumeId = turn.value.sessionId;
    return ok({ text: turn.value.text, changedFiles: turn.value.changedFiles, tokenEstimate: turn.value.tokensDelta });
  };
  return {
    async startSession(task, cwd, reuse, prompt) {
      const stored = reuse ? sessions.get(reuse.id) : undefined;
      const initialPrompt = prompt ?? buildWritePrompt(task);
      if (stored && reuse) {
        Object.assign(stored, { initialPrompt, cwd, taskId: task.id, mode: task.type === 'research' ? 'research' : 'write' });
        return ok({ id: reuse.id, taskId: task.id });
      }
      const id = randomUUID();
      sessions.set(id, { initialPrompt, cwd, taskId: task.id, mode: task.type === 'research' ? 'research' : 'write' });
      return ok({ id, taskId: task.id });
    },
    async waitForStop(session) {
      const stored = sessions.get(session.id); if (!stored) return err('SESSION_ERROR', `Unknown Claude session ${session.id}`);
      if (!stored.initialPrompt) return err('SESSION_ERROR', `Claude session ${session.id} has no pending prompt`);
      const result = await runSessionTurn(session, stored.initialPrompt);
      if (result.ok) stored.initialPrompt = '';
      return result;
    },
    fix: (session, errors) => runSessionTurn(session, `Address the following feedback, make the necessary edits, and stop when done:\n\n${errors}`),
    cleanup: session => runSessionTurn(session, cleanupPrompt),
    async review(request) {
      const started = Date.now();
      const turn = await runTurn(config, config.repoPath, buildReviewPrompt(request), undefined, 'prompt', REVIEW_TIMEOUT_MS);
      return turn.ok ? parseReviewOutput(turn.value.text, request.role, (Date.now() - started) / 1000) : turn;
    },
    async chat(message) {
      const turn = await runTurn(config, config.repoPath, message, undefined, 'prompt', CHAT_TIMEOUT_MS);
      return turn.ok ? ok({ text: turn.value.text, tokensDelta: turn.value.tokensDelta, changedFiles: turn.value.changedFiles, stopReason: turn.value.stopReason }) : turn;
    },
    async scaffold(task) {
      const turn = await runTurn(config, config.repoPath, buildScaffoldPrompt(task), undefined, 'readonly', SCAFFOLD_TIMEOUT_MS);
      return turn.ok ? parseScaffoldOutput(turn.value.text) : turn;
    },
    async evictTaskSessions(taskId) {
      for (const [sessionId, stored] of sessions.entries()) if (stored.taskId === taskId) sessions.delete(sessionId);
      return ok(undefined);
    },
  };
}
