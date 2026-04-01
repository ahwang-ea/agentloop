import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from '../../shared/result.js';
import { resolveConflicts, runSequentialReviews } from '../reviewer.js';
import type { ReviewFinding, ReviewRequest } from '../../types/index.js';

const issue = (
  reviewer: 'opus-bigpicture' | 'codex-detail',
  description: string,
  action: 'change' | 'keep' | 'remove' | 'rename' | 'extract',
  file?: string,
  line?: number,
): ReviewFinding => ({ reviewer, severity: 'issue', description, topicKey: 'topic', action, file, line });

const waitForStarts = async (started: string[], count: number, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (started.length >= count) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${count} reviews to start`);
};

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

test('runs reviews concurrently and returns stable ordering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentloop-review-'));
  const agents = join(root, 'AGENTS.md'), arch = join(root, 'ARCHITECTURE.md');
  await writeFile(agents, '# agents\n', 'utf-8');
  await writeFile(arch, '# architecture\n', 'utf-8');
  const started: string[] = [];
  let release = () => {};
  const ready = new Promise<void>(resolve => { release = resolve; });
  const task = { id: 't', title: 'Task', description: '', scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], type: 'implement' as const, priority: 'medium' as const, createdAt: '' };
  const codexReview = async (request: ReviewRequest) => {
    started.push(request.role);
    await ready;
    return ok({ reviewer: request.role, findings: [], duration: 1, rawOutput: '{}' });
  };
  const claudeReview = async (request: ReviewRequest) => {
    started.push(request.role);
    await ready;
    return ok({ reviewer: request.role, findings: [], duration: 1, rawOutput: '{}' });
  };
  const pending = runSequentialReviews({
    config: { codexEnabled: true, agentsMdPath: agents, architectureMdPath: arch },
    codex: { review: codexReview },
    claude: { review: claudeReview } as never,
  }, task, 'diff');
  await waitForStarts(started, 2);
  const startedBeforeRelease = [...started].sort();
  release();
  const result = await pending;
  expect(result.ok).toBe(true);
  expect(startedBeforeRelease).toEqual(['codex-detail', 'opus-bigpicture']);
  if (!result.ok) return;
  expect(result.value.map(review => review.reviewer)).toEqual(['codex-detail', 'opus-bigpicture']);
});
