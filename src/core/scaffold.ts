import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { err, ok, type Result } from '../shared/result.js';
import { writeStderr } from '../shared/stderr.js';
import type { ClaudeAdapter, ScaffoldFile, ScaffoldOutput, TaskDefinition } from '../types/index.js';
import { extractJson } from './review-output.js';
import { checkScope } from './scope.js';

const CONTENT_TYPES = new Set(['types', 'stub', 'test']);
const asString = (value: unknown) => typeof value === 'string' ? value : '';
const asPath = (value: unknown) => asString(value).trim();
const inScope = (path: string, task: TaskDefinition) => {
  const scoped = checkScope(path, task.scope);
  return scoped.ok && scoped.value.length === 0;
};

export const buildScaffoldPrompt = (task: TaskDefinition) => [
  'You are frontloading a task scaffold before implementation begins.',
  'Inspect the repo with read-only tools and return ONLY JSON: {"files":[...]}.',
  'Allowed file items:',
  '- {"type":"types"|"stub"|"test","path":"relative/path.ts","content":"full file contents"}',
  '- {"type":"golden-copy","path":"relative/path.ts","referencePath":"relative/existing-file.ts"}',
  'Rules:',
  '- Use repo-relative paths only.',
  '- Stub implementations must compile, never throw, and use Result helpers such as return err(\'NOT_IMPLEMENTED\', \'stub\').',
  '- Include any needed imports in stub content.',
  '- Test files must fail initially, be specific, and include edge cases.',
  '- Use golden-copy only when an existing file is the best pattern to copy and adapt.',
  '- When you use golden-copy, choose the closest existing file and put its relative path in referencePath.',
  '- Keep the scaffold minimal and aligned with AGENTS.md.',
  '',
  `Task: ${task.title}`,
  task.description,
  'Acceptance criteria:',
  ...task.acceptanceCriteria.map(item => `- ${item}`),
  `Editable files: ${task.scope.editableFiles.join(', ') || '(none specified)'}`,
  `Read-only context: ${task.scope.readOnlyContext.join(', ') || '(none)'}`,
  `Forbidden files: ${task.scope.forbiddenFiles.join(', ') || '(none)'}`,
].join('\n');

export function parseScaffoldOutput(rawOutput: string): Result<ScaffoldOutput> {
  const json = extractJson(rawOutput);
  if (!json) return err('SESSION_ERROR', 'Malformed scaffold output from Claude');
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch (e) { return err('SESSION_ERROR', `Cannot parse scaffold JSON: ${e instanceof Error ? e.message : 'unknown error'}`); }
  const items = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { files?: unknown }).files) ? (parsed as { files: unknown[] }).files : null;
  if (!items) return err('SESSION_ERROR', 'Scaffold output must be an array or { files: [] }');
  const files: ScaffoldFile[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') return err('SESSION_ERROR', 'Invalid scaffold file');
    const file = item as Record<string, unknown>;
    const type = asPath(file.type) as ScaffoldFile['type'], path = asPath(file.path);
    if (!path) return err('SESSION_ERROR', 'Scaffold file path is required');
    if (type === 'golden-copy') {
      const referencePath = asPath(file.referencePath);
      if (!referencePath) return err('SESSION_ERROR', `Golden-copy scaffold file ${path} needs referencePath`);
      files.push({ type, path, referencePath });
      continue;
    }
    if (!CONTENT_TYPES.has(type)) return err('SESSION_ERROR', `Invalid scaffold file type: ${type || '(missing)'}`);
    const content = asString(file.content);
    if (!content) return err('SESSION_ERROR', `Scaffold file ${path} needs content`);
    files.push({ type, path, content });
  }
  return ok({ files });
}

function safePath(root: string, path: string): Result<string> {
  const full = resolve(root, path), rel = relative(root, full);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? ok(full) : err('SESSION_ERROR', `Scaffold path escapes worktree: ${path}`);
}
async function applyFile(root: string, file: ScaffoldFile): Promise<Result<string>> {
  const dest = safePath(root, file.path); if (!dest.ok) return dest;
  try {
    await mkdir(dirname(dest.value), { recursive: true });
    if (file.type === 'golden-copy') {
      const src = safePath(root, file.referencePath); if (!src.ok) return src;
      await copyFile(src.value, dest.value);
    } else await writeFile(dest.value, file.content, 'utf-8');
    return ok(file.path);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown error';
    return err('TRANSPORT_ERROR', `Cannot write scaffold file ${file.path}: ${message}`);
  }
}
export async function applyScaffold(cwd: string, scaffold: ScaffoldOutput): Promise<Result<string[]>> {
  const written: string[] = [];
  for (const file of scaffold.files) {
    const applied = await applyFile(cwd, file); if (!applied.ok) return applied;
    written.push(applied.value);
  }
  return ok(written);
}

export async function scaffoldTask(
  claude: Pick<ClaudeAdapter, 'scaffold'>, task: TaskDefinition, cwd: string,
): Promise<Result<string[]>> {
  const scaffold = await claude.scaffold(task);
  if (!scaffold.ok) return scaffold;
  const filtered = scaffold.value.files.filter(file => {
    if (inScope(file.path, task)) return true;
    writeStderr(`Scaffold skipped out-of-scope file: ${file.path}`);
    return false;
  });
  return applyScaffold(cwd, { files: filtered });
}
