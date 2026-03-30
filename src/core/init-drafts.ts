import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from '../shared/result.js';
import type { RepoInventory } from '../types/index.js';
import { createClaudeAdapter } from './claude.js';
import { DEFAULT_CONFIG } from './cli-config.js';
import { extractJson } from './review-output.js';

export interface InitDraftBundle {
  agentsMd: string;
  architectureMd: string;
  modules: Array<{ path: string; content: string }>;
  questions: string[];
}

const typeFile = (path: string) => /(^|\/)(types\/|.*\.d\.ts$|.*\.types?\.[cm]?[jt]sx?$)/.test(path);
const topFiles = (inventory: RepoInventory) => [...new Set([
  ...inventory.importFrequency.slice(0, 5).map(item => item.path),
  ...inventory.files.map(file => file.path).filter(typeFile),
])];
const block = async (repoPath: string, path: string) => `FILE: ${path}\n${await readFile(join(repoPath, path), 'utf-8')}`;
const asText = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : '';

function prompt(inventory: RepoInventory, files: string[], previous?: InitDraftBundle, feedback?: string) {
  return [
    'Read this repository inventory and referenced files. Return ONLY JSON.',
    'Shape: {"agentsMd":"...","architectureMd":"...","modules":[{"path":"packages/x/MODULE.md","content":"..."}],"questions":["..."]}',
    'Draft AGENTS.md and ARCHITECTURE.md using actual repo files and conventions, not placeholders.',
    'If this is a monorepo, create one MODULE.md per package. Otherwise return modules: [].',
    'For monorepos, make root AGENTS.md link to the package MODULE.md files and include cross-package rules: one task = one package, common/shared code is read-only for feature agents, and cross-package work should be decomposed into sequential tasks.',
    'Questions must be scenario-based and non-jargony, like accidental breakage, forbidden areas, or choosing between existing patterns.',
    'If two patterns compete, either resolve it in the docs or ask a question about it.',
    '', 'inventory.json:', JSON.stringify(inventory, null, 2),
    '', 'Referenced files:', files.join('\n\n---\n\n'),
    ...(previous ? ['', 'Previous draft JSON:', JSON.stringify(previous)] : []),
    ...(feedback ? ['', 'Revision feedback:', feedback] : []),
  ].join('\n');
}

function parseDrafts(raw: string): Result<InitDraftBundle> {
  const json = extractJson(raw);
  if (!json) return err('SESSION_ERROR', 'Init draft generation returned no JSON');
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch (e) {
    return err('SESSION_ERROR', `Init draft JSON parse failed: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
  const value = parsed as Partial<InitDraftBundle>;
  const modules = Array.isArray(value.modules) ? value.modules.filter(item => item && typeof item.path === 'string' && typeof item.content === 'string') : [];
  const questions = Array.isArray(value.questions) ? value.questions.map(asText).filter(Boolean) : [];
  const agentsMd = asText(value.agentsMd), architectureMd = asText(value.architectureMd);
  return agentsMd && architectureMd ? ok({ agentsMd, architectureMd, modules, questions }) : err('SESSION_ERROR', 'Init draft response was missing AGENTS.md or ARCHITECTURE.md');
}

export async function generateInitDrafts(
  repoPath: string, inventory: RepoInventory, previous?: InitDraftBundle, feedback?: string,
): Promise<Result<InitDraftBundle>> {
  try {
    const files = await Promise.all(topFiles(inventory).map(path => block(repoPath, path)));
    const claude = createClaudeAdapter({ ...DEFAULT_CONFIG, repoPath });
    const result = await claude.chat(prompt(inventory, files, previous, feedback));
    return result.ok ? parseDrafts(result.value.text) : result;
  } catch (e) {
    return err('TRANSPORT_ERROR', `Init draft generation failed: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
}
