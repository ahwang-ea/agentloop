import { readFile } from 'node:fs/promises';
import { err, ok, type Result } from '../shared/result.js';
import { runOrchestrator } from '../orchestrator.js';
import { approveFeatureGate } from './approval.js';
import { runBenchmark } from './benchmark.js';
import { loadConfig } from './cli-config.js';
import { createDeps } from './deps.js';
import { scaffoldRepo } from './init.js';
import { analyzeImprovements, generateImprovementTask } from './improver.js';
import { applyImprovementTasks, formatImprovementAnalysis } from './improver-ui.js';
import { enqueueInteractiveTask } from './interactive-task.js';
import { formatMetricsSummary, readMetricsSummary } from './metrics-report.js';
import { enqueuePlan, generatePlan } from './planner.js';
import { approvePlan } from './planner-ui.js';
import { runRescan } from './rescan.js';
import { formatStatusSummary, readStatusSummary } from './status.js';

export async function handleInit(): Promise<Result<void>> {
  const init = await scaffoldRepo(process.cwd()); if (!init.ok) return init;
  if (init.value.created.length > 0) console.log(`Created: ${init.value.created.join(', ')}`);
  if (init.value.skipped.length > 0) console.log(`Skipped: ${init.value.skipped.join(', ')}`);
  return ok(undefined);
}
export async function handleStart(interactive: boolean, dryRun: boolean, configPath?: string): Promise<Result<void>> {
  const config = await loadConfig(configPath); if (!config.ok) return config;
  const runtime = { ...config.value, autoApproveResearch: false };
  if (dryRun) { console.log(JSON.stringify({ command: 'start', interactive, dryRun, config: runtime }, null, 2)); return ok(undefined); }
  const deps = await createDeps(runtime, interactive); if (!deps.ok) return deps;
  if (interactive) { const queued = await enqueueInteractiveTask(deps.value); if (!queued.ok) return queued; }
  return runOrchestrator(deps.value);
}
export async function handleStatus(configPath?: string): Promise<Result<void>> {
  const config = await loadConfig(configPath); if (!config.ok) return config;
  const summary = await readStatusSummary(config.value); if (!summary.ok) return summary;
  console.log(formatStatusSummary(summary.value)); return ok(undefined);
}
export async function handleMetrics(configPath?: string): Promise<Result<void>> {
  const config = await loadConfig(configPath); if (!config.ok) return config;
  const summary = await readMetricsSummary(config.value); if (!summary.ok) return summary;
  console.log(formatMetricsSummary(summary.value)); return ok(undefined);
}
export async function handleRescan(configPath?: string): Promise<Result<void>> {
  const config = await loadConfig(configPath); if (!config.ok) return config;
  const rescanned = await runRescan(config.value.repoPath); if (!rescanned.ok) return rescanned;
  console.log(rescanned.value); return ok(undefined);
}
export async function handleApprove(taskId: string, configPath?: string): Promise<Result<void>> {
  const config = await loadConfig(configPath); if (!config.ok) return config;
  return approveFeatureGate(config.value, taskId);
}
export async function handlePlan(goal: string | undefined, filePath: string | undefined, configPath?: string): Promise<Result<void>> {
  const config = await loadConfig(configPath); if (!config.ok) return config;
  let text = goal;
  if (!text && filePath) { try { text = (await readFile(filePath, 'utf-8')).trim(); } catch { return err('TRANSPORT_ERROR', `Cannot read ${filePath}`); } }
  if (!text) return err('CONFIG_ERROR', 'plan requires a non-empty goal');
  const deps = await createDeps(config.value, false); if (!deps.ok) return deps;
  const plan = await generatePlan(deps.value, text); if (!plan.ok) return plan;
  const approved = await approvePlan(plan.value); if (!approved.ok || approved.value == null) return approved.ok ? ok(undefined) : approved;
  const queued = await enqueuePlan(deps.value.queue, approved.value); if (!queued.ok) return queued;
  console.log(`Queued ${queued.value.length} planned tasks`); return ok(undefined);
}
export async function handleBenchmark(suite: string | undefined, list: boolean, configPath?: string): Promise<Result<void>> {
  const config = await loadConfig(configPath); if (!config.ok) return config;
  return runBenchmark(config.value, { suite, list });
}
export async function handleImprove(resultsPath: string | undefined, apply: boolean, configPath?: string): Promise<Result<void>> {
  const config = await loadConfig(configPath); if (!config.ok) return config;
  const deps = await createDeps(config.value, false); if (!deps.ok) return deps;
  const analysis = await analyzeImprovements(deps.value, resultsPath); if (!analysis.ok) return analysis;
  console.log(formatImprovementAnalysis(analysis.value));
  if (!apply) return ok(undefined);
  const queued = await applyImprovementTasks(analysis.value, deps.value, generateImprovementTask); if (!queued.ok) return queued;
  console.log(`Queued ${queued.value.length} improvement tasks`); return ok(undefined);
}
