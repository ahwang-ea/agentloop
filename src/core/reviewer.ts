// core/reviewer.ts — Parallel Opus + Codex reviews, conflict resolution.

import { ok, err, type Result } from '../shared/result.js';
import type {
  TaskDefinition, ReviewResult, ReviewFinding, ReviewRequest,
  ClaudeAdapter, CodexAdapter,
} from '../types/index.js';
import { readFile } from 'node:fs/promises';

interface ReviewDeps {
  claude: ClaudeAdapter;
  codex: CodexAdapter;
  config: { codexEnabled: boolean; agentsMdPath: string; architectureMdPath?: string };
}

async function readOptional(path?: string): Promise<Result<string>> {
  if (!path) return ok('');
  try { return ok(await readFile(path, 'utf-8')); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ok('');
    return err('TRANSPORT_ERROR', `Cannot read ${path}`);
  }
}

export async function runParallelReviews(
  deps: ReviewDeps, task: TaskDefinition, diff: string,
): Promise<Result<ReviewResult[]>> {
  if (!deps.config.codexEnabled) {
    return err('CONFIG_ERROR', 'Parallel Opus + Codex review is required by ARCHITECTURE.md');
  }
  const arch = await readOptional(deps.config.architectureMdPath);
  if (!arch.ok) return arch;
  let agentsMd: string;
  try { agentsMd = await readFile(deps.config.agentsMdPath, 'utf-8'); }
  catch { return err('TRANSPORT_ERROR', `Cannot read ${deps.config.agentsMdPath} — required for review`); }
  const base: Omit<ReviewRequest, 'role'> = { diff, taskDefinition: task, architectureMd: arch.value || undefined, agentsMd };
  const results = await Promise.all([
    deps.claude.review({ ...base, role: 'opus-bigpicture' }),
    deps.codex.review({ ...base, role: 'codex-detail' }),
  ]);
  const reviews: ReviewResult[] = [];
  for (const r of results) {
    if (!r.ok) return err(r.error.code, `Review failed: ${r.error.message}`);
    if (!r.value.rawOutput.trim()) return err('EMPTY_RESPONSE', `Review adapter returned blank output for ${r.value.reviewer}`);
    reviews.push(r.value);
  }
  return ok(reviews);
}

export function formatFixPrompt(findings: ReviewFinding[]): string {
  return findings
    .map(f => `[${f.reviewer}] ${f.severity}: ${f.description}${f.file ? ` (${f.file}:${f.line ?? ''})` : ''}`)
    .join('\n');
}

const PROXIMITY_LINES = 5;
function areNearby(a: ReviewFinding, b: ReviewFinding): boolean {
  return a.file === b.file && a.line != null && b.line != null && Math.abs(a.line - b.line) <= PROXIMITY_LINES;
}
function normalize(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function textOverlap(a: string, b: string): number {
  const wa = new Set(normalize(a).split(' ')), wb = new Set(normalize(b).split(' '));
  const inter = [...wa].filter(w => wb.has(w)).length;
  return inter / Math.max(wa.size, wb.size, 1);
}
function isConflict(a: ReviewFinding, b: ReviewFinding): boolean {
  if (a.reviewer === b.reviewer) return false;
  if (a.severity === 'issue' && b.severity === 'issue') return a.topicKey === b.topicKey && a.action !== b.action;
  if (textOverlap(a.description, b.description) < 0.4) return false;
  return a.severity !== b.severity || a.action !== b.action;
}

export function resolveConflicts(findings: ReviewFinding[]): Result<ReviewFinding[]> {
  const located: ReviewFinding[] = [], unlocated: ReviewFinding[] = [];
  for (const f of findings) { (f.file && f.line != null ? located : unlocated).push(f); }
  for (let i = 0; i < unlocated.length; i++) {
    for (let j = i + 1; j < unlocated.length; j++) {
      if (isConflict(unlocated[i], unlocated[j])) return err('REVIEW_CONFLICT', `Conflicting unlocated: [${unlocated[i].reviewer}] ${unlocated[i].description} vs [${unlocated[j].reviewer}] ${unlocated[j].description}`, { findings: [unlocated[i], unlocated[j]] });
    }
  }
  const groups: ReviewFinding[][] = [];
  for (const f of located) {
    const merged: ReviewFinding[][] = [], separate: ReviewFinding[][] = [];
    for (const g of groups) { (g.some(gf => areNearby(gf, f)) ? merged : separate).push(g); }
    separate.push([...merged.flat(), f]);
    groups.length = 0; groups.push(...separate);
  }
  const resolved: ReviewFinding[] = [...unlocated];
  for (const group of groups) {
    if (new Set(group.map(f => f.reviewer)).size <= 1) { resolved.push(...group); continue; }
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (isConflict(group[i], group[j])) return err('REVIEW_CONFLICT', `Conflicting near ${group[i].file}:${group[i].line}: [${group[i].reviewer}] ${group[i].description} vs [${group[j].reviewer}] ${group[j].description}`, { findings: [group[i], group[j]] });
      }
    }
    resolved.push(...group);
  }
  return ok(resolved);
}
