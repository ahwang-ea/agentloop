import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, ClaudeAdapter, TaskDefinition, TaskQueueAdapter } from '../types/index.js';
import { extractJson } from './review-output.js';
import { readRepoFile } from './repo-file.js';
import { scanRepo } from './scanner.js';
import type { PlannedTask } from './planner-types.js';
import { validatePlan } from './planner-validate.js';

interface PlannerDeps { claude: Pick<ClaudeAdapter, 'chat'>; queue: TaskQueueAdapter; config: Pick<AgentloopConfig, 'repoPath' | 'agentsMdPath' | 'architectureMdPath'>; }
const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()) : [];
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const scope = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const uniq = (items: string[]) => [...new Set(items.filter(Boolean))].sort();
const pathPattern = /(?:^|[\s('"`])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)(?=$|[\s)'"`,:;])/g;
const namedFiles = new Set(['README.md', 'package.json', 'tsconfig.json', 'verify.sh']);
const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
const matches = (path: string, patterns: string[]) => patterns.some(pattern => glob(pattern).test(path));
const acceptanceFiles = (items: string[]) => uniq(items.flatMap(item => [...item.matchAll(pathPattern)].map(([, path]) => path)).filter(path => path.includes('/') || namedFiles.has(path)));
const taskType = (value: unknown): PlannedTask['type'] => {
  const normalized = text(value).toLowerCase();
  return normalized === 'test' ? 'implement' : normalized as PlannedTask['type'];
};
const normalizeTask = (task: PlannedTask): PlannedTask => {
  const extras = acceptanceFiles(task.acceptanceCriteria).filter(file => !matches(file, task.scope.editableFiles) && !matches(file, task.scope.readOnlyContext) && !matches(file, task.scope.forbiddenFiles));
  return extras.length === 0 ? task : { ...task, scope: { ...task.scope, editableFiles: uniq([...task.scope.editableFiles, ...extras]) } };
};
export const parsePlanJson = (raw: string): Result<PlannedTask[]> => {
  const json = extractJson(raw); if (!json) return err('SESSION_ERROR', 'Planner returned no JSON');
  let parsed: unknown; try { parsed = JSON.parse(json); } catch { return err('SESSION_ERROR', 'Planner returned invalid JSON'); }
  if (!Array.isArray(parsed)) return err('SESSION_ERROR', 'Planner output must be a JSON array');
  return ok(parsed.map(item => normalizeTask({
    planId: text((item as Record<string, unknown>).planId), title: text((item as Record<string, unknown>).title), description: text((item as Record<string, unknown>).description), feature: text((item as Record<string, unknown>).feature) || undefined,
    type: taskType((item as Record<string, unknown>).type), priority: text((item as Record<string, unknown>).priority) as PlannedTask['priority'],
    scope: { editableFiles: list(scope((item as Record<string, unknown>).scope).editableFiles), readOnlyContext: list(scope((item as Record<string, unknown>).scope).readOnlyContext), forbiddenFiles: list(scope((item as Record<string, unknown>).scope).forbiddenFiles) },
    acceptanceCriteria: list((item as Record<string, unknown>).acceptanceCriteria), dependsOn: list((item as Record<string, unknown>).dependsOn),
  })));
};
const prompt = (goal: string, tree: string[], agents?: string, architecture?: string, issues: string[] = []) => [
  'Plan work for this repository. Return ONLY JSON: an ordered array of tasks.',
  'Do not include markdown fences, prose, or explanations before or after the JSON.',
  'Each task must include: planId, title, description, type, scope, acceptanceCriteria, priority, optional feature, optional dependsOn.',
  'Task type must be research|implement|integrate|debug. Keep each task to 1-3 editable files.',
  'scope must be: { editableFiles: string[], readOnlyContext: string[], forbiddenFiles: string[] }.',
  'CRITICAL: editableFiles MUST be non-empty. Use glob patterns for directories (e.g. ["src/types/*.ts", "src/routes/contacts.ts"]).',
  'For new repos, list paths to create. Always include a glob for the parent directory so supporting files can be created (e.g. "src/types/*.ts" not just "src/types/domain.ts").',
  'If acceptance criteria mention a file path, include that file or its parent glob in editableFiles unless it is read-only context.',
  'If a task adds or updates tests, include the relevant test file path or test-directory glob in editableFiles.',
  'Each task MUST have unique editableFiles — no two tasks may share the exact same set of editable files.',
  'Start with research when external APIs/libraries are needed. Put types-first tasks before implementation tasks.',
  'Keep shared entity names, field names, status values, and DB/service/schema terminology consistent across tasks.',
  'Reuse names from the shared types task instead of introducing aliases like stage/status or body/content unless a mapping layer is explicit.',
  'If shared types mark a field optional, keep it optional across planned tasks unless the goal or acceptance criteria explicitly tighten that contract.',
  'Assume package.json is read-only unless a task must change dependencies; prefer plans that reuse the dependencies already present in the repo.',
  'Do not invent extra library-specific requirements or impossible invariants unless they appear in the goal, architecture, or existing repo files.',
  'Include tests in acceptance criteria. Use dependsOn only for EARLIER planIds.',
  ...(issues.length === 0 ? [] : ['', 'Fix these validation issues from your last attempt:', ...issues.map(issue => `- ${issue}`)]),
  '', 'Goal:', goal, '', 'File tree:', tree.length === 0 ? '(empty repo)' : tree.join('\n'),
  ...(agents ? ['', 'AGENTS.md:', agents] : []), ...(architecture ? ['', 'ARCHITECTURE.md:', architecture] : []),
].join('\n');
const compactPrompt = (goal: string, tree: string[], issues: string[] = []) => [
  'Return ONLY a raw JSON array of task objects.',
  'No markdown, no prose, no explanations, and no bullets.',
  'Each task needs: planId, title, description, type, priority, scope, acceptanceCriteria, dependsOn.',
  'scope must be {"editableFiles":["src/*.ts"],"readOnlyContext":[],"forbiddenFiles":[]}.',
  'Example: [{"planId":"plan-1","title":"Define shared types","description":"Create shared Result and domain types.","type":"implement","priority":"high","scope":{"editableFiles":["src/types/*.ts"],"readOnlyContext":["AGENTS.md","ARCHITECTURE.md"],"forbiddenFiles":["package.json"]},"acceptanceCriteria":["src/types/index.ts exports shared types","npm test passes"],"dependsOn":[]}].',
  ...(issues.length === 0 ? [] : ['', 'Fix these issues:', ...issues.map(issue => `- ${issue}`)]),
  '', 'Goal:', goal, '', 'File tree:', tree.length === 0 ? '(empty repo)' : tree.join('\n'),
].join('\n');
const logPlan = (stage: string, raw: string, stopReason: string, issue: string) => {
  if (process.env.AGENTLOOP_LOG_PLAN !== '1' && process.env.AGENTLOOP_LOG_VERIFY !== '1') return;
  console.error(`[planner:${stage}] stop=${stopReason} issue=${issue} raw=${raw.trim().replace(/\s+/g, ' ').slice(0, 400)}`);
};
const resolvedDeps = (ids: Map<string, string>, task: PlannedTask) => {
  const deps = (task.dependsOn ?? []).map(depId => ({ depId, resolved: ids.get(depId) }));
  const missing = deps.filter(item => !item.resolved).map(item => item.depId);
  return missing.length === 0 ? ok(deps.map(item => item.resolved!)) : err('CONFIG_ERROR', `[${task.planId}] unresolved dependsOn: ${missing.join(', ')}`);
};

export const formatPlan = (plan: PlannedTask[]) => plan.map((task, index) => `${index + 1}. [${task.planId}] [${task.type}] ${task.title}${task.dependsOn?.length ? ` (depends on: ${task.dependsOn.join(', ')})` : ''}`).join('\n');
export async function generatePlan(d: PlannerDeps, goal: string): Promise<Result<PlannedTask[]>> {
  const [agents, architecture, inventory] = await Promise.all([readRepoFile(d.config.repoPath, d.config.agentsMdPath), readRepoFile(d.config.repoPath, d.config.architectureMdPath), scanRepo(d.config.repoPath)]);
  if (!agents.ok) return agents; if (!architecture.ok) return architecture; if (!inventory.ok) return inventory;
  const tree = inventory.value.files.map(file => file.path), jsonOnly = ['Return ONLY a raw JSON array. Do not include markdown fences, prose, or commentary.'];
  const run = async (issues: string[] = [], compact = false) => d.claude.chat(compact ? compactPrompt(goal, tree, issues) : prompt(goal, tree, agents.value, architecture.value, issues));
  const first = await run(); if (!first.ok) return err(first.error.code, `Plan generation failed: ${first.error.message}`);
  let parsed = parsePlanJson(first.value.text);
  if (!parsed.ok) {
    logPlan('initial', first.value.text, first.value.stopReason, parsed.error.message);
    const repair = await run([parsed.error.message, ...jsonOnly]); if (!repair.ok) return err(repair.error.code, `Plan regeneration failed: ${repair.error.message}`);
    parsed = parsePlanJson(repair.value.text);
    if (!parsed.ok) {
      logPlan('repair', repair.value.text, repair.value.stopReason, parsed.error.message);
      const compact = await run([parsed.error.message, ...jsonOnly], true); if (!compact.ok) return err(compact.error.code, `Plan regeneration failed: ${compact.error.message}`);
      parsed = parsePlanJson(compact.value.text); if (!parsed.ok) { logPlan('compact', compact.value.text, compact.value.stopReason, parsed.error.message); return parsed; }
    }
  }
  const issues = validatePlan(parsed.value);
  if (issues.length === 0) return parsed;
  if (process.env.AGENTLOOP_LOG_PLAN === '1' || process.env.AGENTLOOP_LOG_VERIFY === '1') console.error(`[planner:validation-issues] ${issues.join(' | ')}`);
  const second = await run(issues); if (!second.ok) return err(second.error.code, `Plan regeneration failed: ${second.error.message}`);
  let retried = parsePlanJson(second.value.text);
  if (!retried.ok) {
    logPlan('validation', second.value.text, second.value.stopReason, retried.error.message);
    const repair = await run([...issues, retried.error.message, ...jsonOnly], true); if (!repair.ok) return err(repair.error.code, `Plan regeneration failed: ${repair.error.message}`);
    retried = parsePlanJson(repair.value.text); if (!retried.ok) { logPlan('validation-repair', repair.value.text, repair.value.stopReason, retried.error.message); return retried; }
  }
  const retriedIssues = validatePlan(retried.value);
  return retriedIssues.length === 0 ? retried : err('CONFIG_ERROR', `Plan validation failed:\n- ${retriedIssues.join('\n- ')}`);
}

export async function enqueuePlan(queue: TaskQueueAdapter, plan: PlannedTask[]): Promise<Result<TaskDefinition[]>> {
  const issues = validatePlan(plan); if (issues.length > 0) return err('CONFIG_ERROR', `Invalid plan:\n- ${issues.join('\n- ')}`);
  const ids = new Map<string, string>(), tasks: TaskDefinition[] = [];
  for (const item of plan) {
    const deps = resolvedDeps(ids, item); if (!deps.ok) return deps;
    const created = await queue.add({
      title: item.title, description: item.description, feature: item.feature, type: item.type,
      scope: item.scope, acceptanceCriteria: item.acceptanceCriteria, priority: item.priority, dependsOn: deps.value,
    });
    if (!created.ok) return created;
    const task = { ...created.value, feature: item.feature, type: item.type, scope: item.scope, acceptanceCriteria: item.acceptanceCriteria, priority: item.priority, title: item.title, description: item.description, dependsOn: deps.value };
    ids.set(item.planId, created.value.id); tasks.push(task);
  }
  return ok(tasks);
}
