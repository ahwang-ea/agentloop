import { resolveConflicts } from '../reviewer.js';
import type { ReviewFinding } from '../../types/index.js';

const issue = (
  reviewer: 'opus-bigpicture' | 'codex-detail',
  description: string,
  action: 'change' | 'keep' | 'remove' | 'rename' | 'extract',
  file?: string,
  line?: number,
): ReviewFinding => ({ reviewer, severity: 'issue', description, topicKey: 'topic', action, file, line });

describe('resolveConflicts', () => {
  let findings: ReviewFinding[];

  beforeEach(() => {
    findings = [];
  });

  test('passes through non-conflicting findings', () => {
    findings = [
      issue('opus-bigpicture', 'Rename helper for clarity', 'rename'),
      issue('codex-detail', 'Change guard clause', 'change', 'src/app.ts', 10),
      issue('opus-bigpicture', 'Change service call', 'change', 'src/other.ts', 40),
    ];
    const result = resolveConflicts(findings);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(findings);
  });

  test('returns REVIEW_CONFLICT for conflicting unlocated findings', () => {
    findings = [issue('opus-bigpicture', 'Extract this logic', 'extract'), issue('codex-detail', 'Keep this logic inline', 'keep')];
    const result = resolveConflicts(findings);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('REVIEW_CONFLICT');
  });

  test('returns REVIEW_CONFLICT for nearby same-file findings with different actions', () => {
    findings = [
      issue('opus-bigpicture', 'Rename endpoint handler', 'rename', 'src/app.ts', 15),
      issue('codex-detail', 'Remove endpoint handler', 'remove', 'src/app.ts', 18),
    ];
    const result = resolveConflicts(findings);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('REVIEW_CONFLICT');
  });

  test('passes through non-overlapping findings from different reviewers', () => {
    findings = [
      issue('opus-bigpicture', 'Rename endpoint handler', 'rename', 'src/app.ts', 15),
      issue('codex-detail', 'Remove dead helper', 'remove', 'src/app.ts', 40),
    ];
    const result = resolveConflicts(findings);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(findings);
  });
});
