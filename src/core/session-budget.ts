import type { AgentloopConfig, ClaudeSession } from '../types/index.js';

export interface TaskUsage { tokens: number; session?: ClaudeSession; }
export interface WarmSessionState {
  feature?: string;
  session?: ClaudeSession;
  taskCount: number;
  tokenCount: number;
}

export const newTaskUsage = (): TaskUsage => ({ tokens: 0 });
export const emptyWarmSession = (): WarmSessionState => ({ taskCount: 0, tokenCount: 0 });
export const pickWarmSession = (state: WarmSessionState, feature: string | undefined) =>
  feature && state.feature === feature ? state.session : undefined;

export function recordWarmSession(
  state: WarmSessionState,
  feature: string | undefined,
  session: ClaudeSession | undefined,
  tokenEstimate: number,
  config: Pick<AgentloopConfig, 'maxTasksPerSession' | 'maxTokensPerSession'>,
): WarmSessionState {
  if (!feature || !session) return emptyWarmSession();
  const same = state.feature === feature && state.session?.id === session.id;
  const taskCount = same ? state.taskCount + 1 : 1;
  const tokenCount = same ? state.tokenCount + tokenEstimate : tokenEstimate;
  return taskCount >= config.maxTasksPerSession || tokenCount >= config.maxTokensPerSession
    ? emptyWarmSession()
    : { feature, session, taskCount, tokenCount };
}

export function addTaskTokens(usage: TaskUsage, tokens: number): void {
  usage.tokens += Math.max(0, tokens);
}
