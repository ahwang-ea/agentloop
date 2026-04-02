// core/claude-turn.ts — Claude transport and turn normalization helpers.

import { query, type Options, type SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, SessionOutput } from '../types/index.js';
import { systemRuntime, withEnv, type RuntimeDeps } from './runtime.js';
import type { ToolMode } from './claude-session-store.js';

export interface TurnResult extends SessionOutput { sessionId: string; }

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const RESEARCH_TOOLS = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'MultiEdit', 'Bash', 'WebSearch'];
const PROJECT_SETTINGS: SettingSource[] = ['project'];
const READ_ONLY_TURNS = 10;
const WRITE_TURNS = 40;
const RETRY_DELAY_MS = 1_000;
const MAX_ATTEMPTS = 5;

const tokenCount = (usage: unknown) => ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
  .reduce((sum, key) => sum + (typeof (usage as Record<string, unknown> | null)?.[key] === 'number'
    ? Number((usage as Record<string, unknown>)[key])
    : 0), 0);

const stopReason = (raw: string | null, sawHook: boolean): SessionOutput['stopReason'] => (
  sawHook ? 'stop_hook' : raw === 'max_tokens' ? 'max_tokens' : raw === 'tool_use' ? 'tool_use' : 'end_turn'
);

const tools = (mode: ToolMode): string[] | { type: 'preset'; preset: 'claude_code' } => (
  mode === 'write'
    ? { type: 'preset', preset: 'claude_code' }
    : mode === 'research'
      ? RESEARCH_TOOLS
      : mode === 'prompt'
        ? []
        : READ_ONLY_TOOLS
);

const agentic = (mode: ToolMode) => mode === 'write' || mode === 'research';
const transient = (text: string) => /(?:repeated\s+529|\b529\b.*overloaded|api error:|rate limit|temporarily unavailable)/i.test(text);
const appEnv = (runtime: Pick<RuntimeDeps, 'env'>): NodeJS.ProcessEnv => withEnv(runtime, { CLAUDE_AGENT_SDK_CLIENT_APP: 'agentloop/0.1.0' });

export async function runClaudeTurn(
  config: AgentloopConfig,
  cwd: string,
  prompt: string,
  resume: string | undefined,
  mode: ToolMode,
  timeoutMs?: number,
  runtime: RuntimeDeps = systemRuntime,
): Promise<Result<TurnResult>> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let retry = false, hookStop = false, sessionId = resume ?? '';
    const changedFiles = new Set<string>(), abortController = new AbortController();
    const timer = timeoutMs ? runtime.setTimeout(() => abortController.abort(), timeoutMs) : undefined;
    try {
      const options: Options = {
        abortController,
        cwd,
        env: appEnv(runtime),
        maxTurns: agentic(mode) ? WRITE_TURNS : READ_ONLY_TURNS,
        model: config.claudeModel,
        permissionMode: agentic(mode) ? 'acceptEdits' : 'dontAsk',
        settingSources: agentic(mode) ? PROJECT_SETTINGS : undefined,
        ...(agentic(mode) ? { thinking: { type: 'adaptive' } as const, effort: 'max' as const } : {}),
        tools: tools(mode),
        resume,
      };
      for await (const message of query({ prompt, options })) {
        if (message.type === 'system' && message.subtype === 'files_persisted') {
          message.files.forEach(file => changedFiles.add(file.filename));
        }
        if (message.type === 'system' && message.subtype === 'hook_response' && message.hook_event === 'Stop') {
          hookStop = true;
        }
        if (message.type !== 'result') continue;
        sessionId = message.session_id;
        const tokensDelta = tokenCount(message.usage);
        if (message.subtype !== 'success') {
          const reason = message.errors.join('\n') || 'Claude query failed';
          if (attempt < MAX_ATTEMPTS - 1 && transient(reason)) { retry = true; break; }
          return err('SESSION_ERROR', reason, { sessionId });
        }
        if (transient(message.result)) {
          if (attempt < MAX_ATTEMPTS - 1) { retry = true; break; }
          return err('SESSION_ERROR', message.result, { sessionId });
        }
        return ok({
          text: message.result,
          tokensDelta,
          changedFiles: [...changedFiles],
          stopReason: stopReason(message.stop_reason, hookStop),
          sessionId,
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown error';
      if (abortController.signal.aborted && timeoutMs) {
        return err('BUDGET_EXCEEDED', `Claude ${mode} timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      if (attempt < MAX_ATTEMPTS - 1 && transient(message)) retry = true;
      else return err('SESSION_ERROR', `Claude query failed: ${message}`);
    } finally {
      if (timer) runtime.clearTimeout(timer);
    }
    if (!retry) return err('EMPTY_RESPONSE', 'Claude query returned no result');
    await runtime.sleep(RETRY_DELAY_MS * (attempt + 1));
  }
  return err('SESSION_ERROR', 'Claude query hit repeated transient API errors');
}
