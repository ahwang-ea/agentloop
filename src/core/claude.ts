// core/claude.ts — Claude Agent SDK adapter implementation.

import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, ClaudeAdapter, ClaudeSession, SessionOutput, WriterOutput } from '../types/index.js';
import { buildReviewPrompt, parseReviewOutput } from './review-output.js';
import { buildScaffoldPrompt, parseScaffoldOutput } from './scaffold.js';
import { cleanupPrompt, buildWritePrompt } from './writer-prompt.js';

type ToolMode = 'readonly' | 'write' | 'research';
interface StoredSession { initialPrompt: string; resumeId?: string; cwd: string; taskId: string; mode: Exclude<ToolMode, 'readonly'>; }
interface TurnResult extends SessionOutput { sessionId: string; }
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const RESEARCH_TOOLS = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'MultiEdit', 'Bash', 'WebSearch'];
const appEnv = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'agentloop/0.1.0' };
const tokenCount = (usage: unknown) => ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
  .reduce((sum, key) => sum + (typeof (usage as Record<string, unknown> | null)?.[key] === 'number' ? Number((usage as Record<string, unknown>)[key]) : 0), 0);
const stopReason = (raw: string | null, sawHook: boolean): SessionOutput['stopReason'] => sawHook
  ? 'stop_hook' : raw === 'max_tokens' ? 'max_tokens' : raw === 'tool_use' ? 'tool_use' : 'end_turn';
const tools = (mode: ToolMode): string[] | { type: 'preset'; preset: 'claude_code' } => mode === 'write' ? { type: 'preset', preset: 'claude_code' } : mode === 'research' ? RESEARCH_TOOLS : READ_ONLY_TOOLS;

async function runTurn(
  config: AgentloopConfig, cwd: string, prompt: string, resume: string | undefined, mode: ToolMode,
): Promise<Result<TurnResult>> {
  let text = '', tokensDelta = 0, sessionId = resume ?? '', hookStop = false;
  const changedFiles = new Set<string>();
  try {
    for await (const message of query({
      prompt,
      options: {
        cwd,
        env: appEnv,
        maxTurns: mode === 'readonly' ? 10 : 40,
        model: config.claudeModel,
        permissionMode: mode === 'readonly' ? 'dontAsk' : 'acceptEdits',
        settingSources: ['project'],
        tools: tools(mode),
        resume,
      },
    })) {
      if (message.type === 'system' && message.subtype === 'files_persisted') message.files.forEach(file => changedFiles.add(file.filename));
      if (message.type === 'system' && message.subtype === 'hook_response' && message.hook_event === 'Stop') hookStop = true;
      if (message.type !== 'result') continue;
      sessionId = message.session_id;
      tokensDelta = tokenCount(message.usage);
      if (message.subtype !== 'success') return err('SESSION_ERROR', message.errors.join('\n') || 'Claude query failed', { sessionId });
      text = message.result;
      return ok({ text, tokensDelta, changedFiles: [...changedFiles], stopReason: stopReason(message.stop_reason, hookStop), sessionId });
    }
  } catch (e) {
    return err('SESSION_ERROR', `Claude query failed: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
  return err('EMPTY_RESPONSE', 'Claude query returned no result');
}

export function createClaudeAdapter(config: AgentloopConfig): ClaudeAdapter {
  const sessions = new Map<string, StoredSession>();
  const runSessionTurn = async (session: ClaudeSession, prompt: string): Promise<Result<WriterOutput>> => {
    const stored = sessions.get(session.id); if (!stored) return err('SESSION_ERROR', `Unknown Claude session ${session.id}`);
    const turn = await runTurn(config, stored.cwd, prompt, stored.resumeId, stored.mode); if (!turn.ok) return turn;
    stored.resumeId = turn.value.sessionId;
    return ok({ text: turn.value.text, changedFiles: turn.value.changedFiles, tokenEstimate: turn.value.tokensDelta });
  };
  return {
    async startSession(task, cwd, reuse) {
      const stored = reuse ? sessions.get(reuse.id) : undefined;
      if (stored && reuse) {
        Object.assign(stored, { initialPrompt: buildWritePrompt(task), cwd, taskId: task.id, mode: task.type === 'research' ? 'research' : 'write' });
        return ok({ id: reuse.id, taskId: task.id });
      }
      const id = randomUUID();
      sessions.set(id, { initialPrompt: buildWritePrompt(task), cwd, taskId: task.id, mode: task.type === 'research' ? 'research' : 'write' });
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
      const turn = await runTurn(config, config.repoPath, buildReviewPrompt(request), undefined, 'readonly');
      return turn.ok ? parseReviewOutput(turn.value.text, request.role, (Date.now() - started) / 1000) : turn;
    },
    async chat(message) {
      const turn = await runTurn(config, config.repoPath, message, undefined, 'readonly');
      return turn.ok ? ok({ text: turn.value.text, tokensDelta: turn.value.tokensDelta, changedFiles: turn.value.changedFiles, stopReason: turn.value.stopReason }) : turn;
    },
    async scaffold(task) {
      const turn = await runTurn(config, config.repoPath, buildScaffoldPrompt(task), undefined, 'readonly');
      return turn.ok ? parseScaffoldOutput(turn.value.text) : turn;
    },
    async evictTaskSessions(taskId) {
      for (const [sessionId, stored] of sessions.entries()) if (stored.taskId === taskId) sessions.delete(sessionId);
      return ok(undefined);
    },
  };
}
