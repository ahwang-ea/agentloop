import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { err, ok, type Result } from '../shared/result.js';
import type { RepoInventory } from '../types/index.js';
import { readInventory } from './scanner.js';
import { checkInitCoverage } from './init-coverage.js';
import { generateInitDrafts, type InitDraftBundle } from './init-drafts.js';
import { normalizeInitDrafts } from './init-monorepo.js';

const sourceFile = (path: string) => /\.[cm]?[jt]sx?$|\.py$/.test(path) && !/^(\.agentloop|\.claude|dist|node_modules)\//.test(path);
const uniq = (items: string[]) => [...new Set(items.map(item => item.trim()).filter(Boolean))];
const withUnknowns = (agentsMd: string, unknowns: string[]) => unknowns.length === 0 ? agentsMd : `${agentsMd.trim()}\n\n## Known unknowns\n${unknowns.map(item => `- ${item}`).join('\n')}`;

async function ask(questions: string[]) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || questions.length === 0) return [] as Array<{ question: string; answer: string }>;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return Promise.all(questions.map(async question => ({ question, answer: (await rl.question(`${question}\n> `)).trim() }))); }
  finally { rl.close(); }
}
async function writeDraftArtifacts(repoPath: string, drafts: InitDraftBundle, coverageSummary: string, questions: string[]) {
  await mkdir(join(repoPath, '.agentloop', 'drafts'), { recursive: true });
  await writeFile(join(repoPath, '.agentloop', 'drafts', 'AGENTS.md'), drafts.agentsMd, 'utf-8');
  await writeFile(join(repoPath, '.agentloop', 'drafts', 'ARCHITECTURE.md'), drafts.architectureMd, 'utf-8');
  await writeFile(join(repoPath, '.agentloop', 'init-questions.json'), JSON.stringify(questions, null, 2), 'utf-8');
  await writeFile(join(repoPath, '.agentloop', 'coverage.json'), JSON.stringify({ summary: coverageSummary }, null, 2), 'utf-8');
}
async function writeFinalDocs(repoPath: string, drafts: InitDraftBundle, unknowns: string[]) {
  await writeFile(join(repoPath, 'AGENTS.md'), withUnknowns(drafts.agentsMd, unknowns), 'utf-8');
  await writeFile(join(repoPath, 'ARCHITECTURE.md'), drafts.architectureMd, 'utf-8');
  for (const moduleDoc of drafts.modules) {
    await mkdir(join(repoPath, moduleDoc.path, '..'), { recursive: true });
    await writeFile(join(repoPath, moduleDoc.path), moduleDoc.content, 'utf-8');
  }
}
function feedback(answers: Array<{ question: string; answer: string }>, missing: string[]) {
  return [...answers.filter(item => item.answer).map(item => `${item.question}\nAnswer: ${item.answer}`), ...(missing.length === 0 ? [] : [`Coverage gaps to resolve or mark as known unknowns: ${missing.join('; ')}`])].join('\n\n');
}

export const shouldRunSmartInit = (inventory: RepoInventory) => inventory.files.some(file => sourceFile(file.path));

export async function runSmartInit(repoPath: string): Promise<Result<void>> {
  const inventory = await readInventory(repoPath);
  if (!inventory.ok || !inventory.value) return inventory.ok ? err('CONFIG_ERROR', 'inventory.json is required for smart init') : inventory;
  const first = await generateInitDrafts(repoPath, inventory.value); if (!first.ok) return first;
  let drafts = normalizeInitDrafts(inventory.value, first.value);
  let coverage = await checkInitCoverage(inventory.value, drafts); if (!coverage.ok) return coverage;
  await writeDraftArtifacts(repoPath, drafts, coverage.value.summary, drafts.questions);
  let remaining = drafts.questions;
  for (let round = 0; round < 2 && remaining.length > 0; round++) {
    const answers = await ask(remaining); if (answers.every(item => !item.answer)) break;
    const revised = await generateInitDrafts(repoPath, inventory.value, drafts, feedback(answers, coverage.value.missing));
    if (!revised.ok) return revised;
    drafts = normalizeInitDrafts(inventory.value, revised.value);
    coverage = await checkInitCoverage(inventory.value, drafts); if (!coverage.ok) return coverage;
    remaining = drafts.questions.filter((question: string) => !answers.some(item => item.question === question && item.answer));
    await writeDraftArtifacts(repoPath, drafts, coverage.value.summary, remaining);
  }
  await writeFinalDocs(repoPath, drafts, uniq([...remaining, ...coverage.value.missing]));
  return ok(undefined);
}
