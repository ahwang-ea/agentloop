// core/review-output.ts — Shared review prompt and JSON parsing.

import { err, ok, type Result } from '../shared/result.js';
import type { FindingAction, ReviewFinding, ReviewRequest, ReviewResult } from '../types/index.js';

const ACTIONS = new Set(['keep', 'change', 'remove', 'rename', 'extract']);
const label = (role: ReviewRequest['role']) => role === 'opus-bigpicture'
  ? 'big-picture architecture and maintainability reviewer'
  : 'detail-oriented correctness and edge-case reviewer';

export function buildReviewPrompt(request: ReviewRequest): string {
  return [
    `You are the ${label(request.role)}.`,
    'Review the proposed diff against the task, AGENTS.md, and ARCHITECTURE.md when present.',
    'Return ONLY JSON: {"findings":[...]} and use [] when clean.',
    'Finding shape: severity(issue|suggestion), description, optional file, optional line.',
    'Issue findings MUST include topicKey and action(change|keep|remove|rename|extract).',
    '',
    `Task: ${request.taskDefinition.title}`,
    request.taskDefinition.description,
    'Acceptance criteria:',
    ...request.taskDefinition.acceptanceCriteria.map(item => `- ${item}`),
    '',
    'AGENTS.md:',
    request.agentsMd,
    ...(request.architectureMd ? ['', 'ARCHITECTURE.md:', request.architectureMd] : []),
    '',
    'Diff:',
    request.diff,
  ].join('\n');
}

export function extractJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  for (const candidate of [trimmed, trimmed.replace(/^```json\s*|```$/gim, '').trim()]) {
    try { JSON.parse(candidate); return candidate; } catch {}
  }
  for (let start = 0; start < trimmed.length; start++) {
    if (!'{['.includes(trimmed[start])) continue;
    let quote = false, escape = false, depth = 0;
    const open = trimmed[start], close = open === '{' ? '}' : ']';
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (quote) { escape = ch === '\\' && !escape; if (ch === '"' && !escape) quote = false; continue; }
      if (ch === '"') quote = true;
      if (ch === open) depth++;
      if (ch === close && --depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return '';
}

const asText = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : '';
const asLine = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

export function parseReviewOutput(rawOutput: string, reviewer: ReviewRequest['role'], duration: number): Result<ReviewResult> {
  const json = extractJson(rawOutput);
  if (!json) return err('SESSION_ERROR', `Malformed review output from ${reviewer}`);
  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch (e) { return err('SESSION_ERROR', `Cannot parse review JSON from ${reviewer}: ${e instanceof Error ? e.message : 'unknown error'}`); }
  const items = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { findings?: unknown }).findings)
    ? (parsed as { findings: unknown[] }).findings : null;
  if (!items) return err('SESSION_ERROR', `Review output from ${reviewer} must be an array or { findings: [] }`);
  const findings: ReviewFinding[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') return err('SESSION_ERROR', `Invalid finding from ${reviewer}`);
    const finding = item as Record<string, unknown>;
    const severity = asText(finding.severity);
    const description = asText(finding.description);
    const file = asText(finding.file) || undefined;
    const line = asLine(finding.line);
    const topicKey = asText(finding.topicKey) || undefined;
    const action = (asText(finding.action) || undefined) as FindingAction | undefined;
    if (!description || (severity !== 'issue' && severity !== 'suggestion'))
      return err('SESSION_ERROR', `Invalid finding shape from ${reviewer}`);
    if (action && !ACTIONS.has(action)) return err('SESSION_ERROR', `Invalid review action from ${reviewer}: ${action}`);
    if (severity === 'issue') {
      if (!topicKey || !action) return err('SESSION_ERROR', `Issue findings from ${reviewer} require topicKey and action`);
      findings.push({ reviewer, severity, description, file, line, topicKey, action });
    } else findings.push({ reviewer, severity, description, file, line, topicKey, action });
  }
  return ok({ reviewer, findings, duration, rawOutput });
}
