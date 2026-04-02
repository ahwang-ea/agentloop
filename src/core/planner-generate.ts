import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, ClaudeAdapter, TaskDefinition, TaskQueueAdapter } from '../types/index.js';
import { readRepoFile } from './repo-file.js';
import { scanRepo } from './scanner.js';
import { parsePlanJson } from './planner-json.js';
import { compactPrompt, jsonOnlyIssues, logPlan, logValidationIssues, prompt } from './planner-prompt.js';
import type { PlannedTask } from './planner-types.js';
import { validatePlan } from './planner-validate.js';

interface PlannerDeps { claude: Pick<ClaudeAdapter, 'chat'>; queue: TaskQueueAdapter; config: Pick<AgentloopConfig, 'repoPath' | 'agentsMdPath' | 'architectureMdPath'>; }
interface PlannerDocs { agents?: string; architecture?: string; }

const loadDocs = async (config: PlannerDeps['config']): Promise<Result<PlannerDocs>> => {
  const [agents, architecture] = await Promise.all([readRepoFile(config.repoPath, config.agentsMdPath), readRepoFile(config.repoPath, config.architectureMdPath)]);
  if (!agents.ok) return agents;
  if (!architecture.ok) return architecture;
  return ok({ agents: agents.value, architecture: architecture.value });
};

const resolvedDeps = (ids: Map<string, string>, task: PlannedTask) => {
  const deps = (task.dependsOn ?? []).map(depId => ({ depId, resolved: ids.get(depId) }));
  const missing = deps.filter(item => !item.resolved).map(item => item.depId);
  return missing.length === 0 ? ok(deps.map(item => item.resolved!)) : err('CONFIG_ERROR', `[${task.planId}] unresolved dependsOn: ${missing.join(', ')}`);
};

export const formatPlan = (plan: PlannedTask[]) => plan.map((task, index) => `${index + 1}. [${task.planId}] [${task.type}] ${task.title}${task.dependsOn?.length ? ` (depends on: ${task.dependsOn.join(', ')})` : ''}`).join('\n');

export async function generatePlan(d: PlannerDeps, goal: string): Promise<Result<PlannedTask[]>> {
  const inventory = await scanRepo(d.config.repoPath); if (!inventory.ok) return inventory;
  const tree = inventory.value.files.map(file => file.path);
  let docs: PlannerDocs | undefined;
  const run = async (issues: string[] = [], expanded = false) => {
    if (!expanded) return d.claude.chat(compactPrompt(goal, tree, issues));
    if (!docs) {
      const loaded = await loadDocs(d.config);
      if (!loaded.ok) return loaded;
      docs = loaded.value;
    }
    return d.claude.chat(prompt(goal, tree, docs?.agents, docs?.architecture, issues));
  };

  const first = await run(); if (!first.ok) return err(first.error.code, `Plan generation failed: ${first.error.message}`);
  let parsed = parsePlanJson(first.value.text);
  if (!parsed.ok) {
    logPlan('initial', first.value.text, first.value.stopReason, parsed.error.message);
    const repair = await run([parsed.error.message, ...jsonOnlyIssues]); if (!repair.ok) return err(repair.error.code, `Plan regeneration failed: ${repair.error.message}`);
    parsed = parsePlanJson(repair.value.text);
    if (!parsed.ok) {
      logPlan('repair', repair.value.text, repair.value.stopReason, parsed.error.message);
      const expanded = await run([parsed.error.message, ...jsonOnlyIssues], true); if (!expanded.ok) return err(expanded.error.code, `Plan regeneration failed: ${expanded.error.message}`);
      parsed = parsePlanJson(expanded.value.text); if (!parsed.ok) { logPlan('expanded', expanded.value.text, expanded.value.stopReason, parsed.error.message); return parsed; }
    }
  }

  const issues = validatePlan(parsed.value);
  if (issues.length === 0) return parsed;
  logValidationIssues(issues);
  const second = await run(issues, true); if (!second.ok) return err(second.error.code, `Plan regeneration failed: ${second.error.message}`);
  let retried = parsePlanJson(second.value.text);
  if (!retried.ok) {
    logPlan('validation', second.value.text, second.value.stopReason, retried.error.message);
    const repair = await run([...issues, retried.error.message, ...jsonOnlyIssues], true); if (!repair.ok) return err(repair.error.code, `Plan regeneration failed: ${repair.error.message}`);
    retried = parsePlanJson(repair.value.text); if (!retried.ok) { logPlan('validation-repair', repair.value.text, repair.value.stopReason, retried.error.message); return retried; }
  }
  const retriedIssues = validatePlan(retried.value);
  return retriedIssues.length === 0 ? retried : err('CONFIG_ERROR', `Plan validation failed:\n- ${retriedIssues.join('\n- ')}`);
}

/** Flatten dependency graph to depth-2: first task has no deps, all others depend only on it. */
export function flattenPlan(plan: PlannedTask[]): PlannedTask[] {
  if (plan.length <= 1) return plan;
  const root = plan[0];
  return [
    { ...root, dependsOn: [] },
    ...plan.slice(1).map(task => ({ ...task, dependsOn: [root.planId] })),
  ];
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
    ids.set(item.planId, created.value.id);
    tasks.push({ ...created.value, feature: item.feature, type: item.type, scope: item.scope, acceptanceCriteria: item.acceptanceCriteria, priority: item.priority, title: item.title, description: item.description, dependsOn: deps.value });
  }
  return ok(tasks);
}
