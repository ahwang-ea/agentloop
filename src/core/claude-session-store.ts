// core/claude-session-store.ts — Claude session cache helpers.

import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from '../shared/result.js';
import type { ClaudeSession, TaskDefinition } from '../types/index.js';

export type ToolMode = 'readonly' | 'write' | 'research' | 'prompt';
export interface StoredSession {
  initialPrompt: string;
  resumeId?: string;
  cwd: string;
  taskId: string;
  mode: Exclude<ToolMode, 'readonly' | 'prompt'>;
}

const modeForTask = (task: TaskDefinition): StoredSession['mode'] => (
  task.type === 'research' ? 'research' : 'write'
);

export function createOrReuseClaudeSession(
  sessions: Map<string, StoredSession>,
  task: TaskDefinition,
  cwd: string,
  reuse: ClaudeSession | undefined,
  initialPrompt: string,
): ClaudeSession {
  const next = { initialPrompt, cwd, taskId: task.id, mode: modeForTask(task) };
  const stored = reuse ? sessions.get(reuse.id) : undefined;
  if (stored && reuse) {
    Object.assign(stored, next);
    return { id: reuse.id, taskId: task.id };
  }
  const id = randomUUID();
  sessions.set(id, next);
  return { id, taskId: task.id };
}

export function getClaudeSession(
  sessions: Map<string, StoredSession>,
  session: ClaudeSession,
): Result<StoredSession> {
  const stored = sessions.get(session.id);
  return stored ? ok(stored) : err('SESSION_ERROR', `Unknown Claude session ${session.id}`);
}

export function evictClaudeTaskSessions(
  sessions: Map<string, StoredSession>,
  taskId: string,
): void {
  for (const [sessionId, stored] of sessions.entries()) {
    if (stored.taskId === taskId) sessions.delete(sessionId);
  }
}
