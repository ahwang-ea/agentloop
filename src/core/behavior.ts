// core/behavior.ts — Detects externally visible changes from git diff.

import type { BehaviorCheckResult, BehaviorChange } from '../types/index.js';

const DETECTORS: Array<{ type: BehaviorChange['type']; description: string; pattern: RegExp }> = [
  { type: 'endpoint', description: 'API route definitions changed', pattern: /\.(get|post|put|delete|patch)\s*\(|router\.|app\./i },
  { type: 'config', description: 'Configuration files changed', pattern: /\.env|config\.|\.json/i },
  { type: 'schema', description: 'Schema or migration files changed', pattern: /schema|migration|\.sql/i },
  { type: 'auth', description: 'Authentication or authorization behavior changed', pattern: /\b(auth|permission|token|jwt|rbac)\b/i },
  { type: 'error-behavior', description: 'Error handling or status-code behavior changed', pattern: /\berror\b|\bthrow\b|\bcatch\b|status\s*code|status\((?:\d{3})\)|status:\s*\d{3}/i },
  { type: 'timing', description: 'Timeout, retry, rate-limit, or delay behavior changed', pattern: /\b(timeout|retry|ttl|delay)\b|rate.?limit/i },
];

export function detectBehaviorChanges(diff: string): BehaviorCheckResult {
  const lines = diff.split('\n');
  const changes = DETECTORS.flatMap(({ type, description, pattern }) => {
    const files = extractChangedFiles(lines, pattern);
    return files.length > 0 ? [{ type, description, files }] : [];
  });
  return {
    hasChanges: changes.length > 0,
    changes,
    readmeUpdateNeeded: changes.some(change => change.type === 'endpoint' || change.type === 'schema'),
  };
}

function extractChangedFiles(lines: string[], pattern: RegExp): string[] {
  const files: string[] = [];
  let currentFile = '';
  for (const line of lines) {
    if (line.startsWith('+++ b/')) currentFile = line.slice(6);
    if (line.startsWith('+') && !line.startsWith('+++') && pattern.test(line)) {
      if (currentFile && !files.includes(currentFile)) files.push(currentFile);
    }
  }
  return files;
}
