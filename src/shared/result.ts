// shared/result.ts — Structured Result type with typed error codes.

export type ErrorCode =
  | 'MERGE_CONFLICT' | 'DIRTY_TREE' | 'BRANCH_NOT_FOUND'
  | 'CONFIG_ERROR'
  | 'QUEUE_PARSE_ERROR' | 'QUEUE_EMPTY' | 'QUEUE_CORRUPT'
  | 'VERIFY_FAILED' | 'BUDGET_EXCEEDED' | 'STUCK' | 'THRASHING'
  | 'EMPTY_RESPONSE' | 'TRANSPORT_ERROR' | 'SESSION_ERROR'
  | 'REVIEW_CONFLICT' | 'REVIEW_STUCK' | 'SWEEP_PARSE_ERROR' | 'NOTIFY_FAILED'
  | 'FINALIZATION_PERSIST_FAILED'
  | 'GIT_ERROR'
  | 'UNKNOWN';

export interface OrchestratorError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: OrchestratorError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const err = (
  code: ErrorCode, message: string, details?: Record<string, unknown>,
): Result<never> => ({ ok: false, error: { code, message, details } });
