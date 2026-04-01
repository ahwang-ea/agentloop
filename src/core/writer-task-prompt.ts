import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskDefinition } from '../types/index.js';
import { learningsAddendum } from './learnings.js';
import { buildFixPrompt, buildWritePrompt, concreteTargetsOf } from './writer-prompt.js';
import { createNote } from './writer-retry.js';

const codeFile = (file: string) => /\.[cm]?[jt]sx?$/.test(file);
const uniq = (items: string[]) => [...new Set(items.filter(Boolean))];
const targetNames = (task: TaskDefinition) => new Set(concreteTargetsOf(task).map(file => file.split('/').pop() ?? file));

async function siblingExamples(cwd: string, task: TaskDefinition): Promise<string[]> {
  const examples: string[] = [], targets = targetNames(task);
  const dirs = uniq(task.scope.editableFiles.map(file => file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.')).slice(0, 3);
  for (const dir of dirs) try {
    for (const name of (await readdir(join(cwd, dir))).sort()) if (codeFile(name) && !targets.has(name)) examples.push(dir === '.' ? name : `${dir}/${name}`);
  } catch {}
  return uniq(examples).slice(0, 6);
}

export async function buildTaskPrompt(repoPath: string, cwd: string, task: TaskDefinition): Promise<string> {
  const prompt = buildWritePrompt(task, await siblingExamples(cwd, task)), learnings = await learningsAddendum({ repoPath }, task);
  return learnings.ok && learnings.value ? `${prompt}\n\n${learnings.value}` : prompt;
}
export async function buildTaskFixPrompt(cwd: string, task: TaskDefinition, prompt: string): Promise<string> {
  return buildFixPrompt(task, prompt, await siblingExamples(cwd, task));
}
export async function buildForceCreatePrompt(cwd: string, task: TaskDefinition): Promise<string> {
  const targets = concreteTargetsOf(task);
  return [
    buildWritePrompt(task, await siblingExamples(cwd, task)), '',
    targets.length === 0 ? createNote : `Create these exact in-scope files now: ${targets.join(', ')}`,
    'Do not stop until at least one of them exists with real code or tests.',
  ].join('\n');
}
