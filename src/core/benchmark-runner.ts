import { rm } from 'node:fs/promises';
import type { BenchmarkCatalogEntry, BenchmarkResult } from '../benchmarks/types.js';
import { ok, type Result } from '../shared/result.js';
import { writeStderr } from '../shared/stderr.js';
import type { AgentloopConfig, MetricsRecord } from '../types/index.js';
import { runOrchestrator } from '../orchestrator.js';
import { runAcceptanceTests } from './benchmark-acceptance.js';
import { bootstrapBenchmarkRepo } from './benchmark-bootstrap.js';
import { createDeps } from './deps.js';
import { readMetricsRecords } from './metrics-report.js';
import { enqueuePlan, generatePlan } from './planner.js';

const round = (value: number) => Math.round(value * 100) / 100;
const score = (completed: number, total: number, passed: number, checks: number) => total === 0 || checks === 0 ? 0 : round((completed / total) * (passed / checks));
const failed = (entry: BenchmarkCatalogEntry, started: number, output: string): BenchmarkResult => ({ suite: entry.fileStem, timestamp: new Date().toISOString(), duration: Math.round((Date.now() - started) / 1000), tasksTotal: 0, tasksCompleted: 0, tasksStuck: 0, avgRounds: 0, avgTimeSec: 0, firstPassRate: 0, acceptanceTests: [{ name: 'setup', passed: false, output }], score: 0, metricsSnapshot: [] });
const logBenchmark = (entry: BenchmarkCatalogEntry, message: string) => writeStderr(`[benchmark:${entry.fileStem}] ${message}`);
const summarize = (metrics: MetricsRecord[]) => ({
  avgRounds: metrics.length === 0 ? 0 : round(metrics.reduce((sum, item) => sum + item.rounds, 0) / metrics.length),
  avgTimeSec: metrics.length === 0 ? 0 : round(metrics.reduce((sum, item) => sum + item.timeSec, 0) / metrics.length),
  firstPassRate: metrics.length === 0 ? 0 : round((metrics.filter(item => item.rounds <= 1).length / metrics.length) * 100),
});
const transientPlanError = (message: string) => /api error|overloaded|internal server error|timed out/i.test(message);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, process.env.NODE_ENV === 'test' ? 1 : ms));
const planWithRetry = async (entry: BenchmarkCatalogEntry, deps: Awaited<ReturnType<typeof createDeps>> extends Result<infer T> ? T : never) => {
  let planned = await generatePlan(deps, entry.suite.goal);
  for (let attempt = 0; !planned.ok && attempt < 2 && transientPlanError(planned.error.message); attempt += 1) {
    logBenchmark(entry, `planning retry ${attempt + 1}/2: ${planned.error.message}`);
    await pause((attempt + 1) * 5_000);
    planned = await generatePlan(deps, entry.suite.goal);
  }
  return planned;
};

export async function runBenchmarkSuite(entry: BenchmarkCatalogEntry, base: AgentloopConfig): Promise<Result<BenchmarkResult>> {
  const started = Date.now();
  let repoPath = '';
  try {
    const boot = await bootstrapBenchmarkRepo(entry); if (!boot.ok) { logBenchmark(entry, `bootstrap failed: ${boot.error.message}`); return ok(failed(entry, started, boot.error.message)); }
    repoPath = boot.value;
    const config: AgentloopConfig = { ...base, repoPath, worktreeRoot: `${repoPath}/.worktrees`, taskFilePath: `${repoPath}/tasks.json`, agentsMdPath: `${repoPath}/AGENTS.md`, architectureMdPath: `${repoPath}/ARCHITECTURE.md`, verifyCommand: 'AGENTLOOP_SKIP_DEPCHECK=1 ./verify.sh', integrationTestCommand: 'npm test -- --maxWorkers=100%', convergence: { ...base.convergence, stuckThreshold: Math.max(base.convergence.stuckThreshold, 8), thrashOverlapRatio: 1.01 }, maxParallelAgents: Math.max(base.maxParallelAgents, 2), autoApproveResearch: true, autoApproveFeatures: true, reviewEnabled: false, readmeTasksEnabled: false, sweepInterval: 0 };
    const deps = await createDeps(config, false); if (!deps.ok) { logBenchmark(entry, `deps failed: ${deps.error.message}`); return ok(failed(entry, started, deps.error.message)); }
    const planned = await planWithRetry(entry, deps.value); if (!planned.ok) { logBenchmark(entry, `planning failed: ${planned.error.message}`); return ok(failed(entry, started, planned.error.message)); }
    const enqueued = await enqueuePlan(deps.value.queue, planned.value); if (!enqueued.ok) { logBenchmark(entry, `enqueue failed: ${enqueued.error.message}`); return ok(failed(entry, started, enqueued.error.message)); }
    const orchestrated = await runOrchestrator(deps.value, Date.now() + (entry.suite.maxTimeSec * 1000));
    const acceptance = await runAcceptanceTests(repoPath, entry.suite.acceptanceTests), metrics = await readMetricsRecords({ repoPath }), tasks = await deps.value.queue.list();
    if (!acceptance.ok) logBenchmark(entry, `acceptance failed: ${acceptance.error.message}`);
    if (!metrics.ok) logBenchmark(entry, `metrics failed: ${metrics.error.message}`);
    if (!tasks.ok) logBenchmark(entry, `queue failed: ${tasks.error.message}`);
    if (!orchestrated.ok) logBenchmark(entry, `orchestrator failed: ${orchestrated.error.message}`);
    if (tasks.ok) {
      const counts = Object.fromEntries(tasks.value.reduce((map, task) => map.set(task.status, (map.get(task.status) ?? 0) + 1), new Map<string, number>()));
      logBenchmark(entry, `queue counts: ${JSON.stringify(counts)}`);
    }
    if (metrics.ok) logBenchmark(entry, `metrics count: ${metrics.value.length}`);
    const checks = [
      ...(acceptance.ok ? acceptance.value : [{ name: 'acceptance', passed: false, output: acceptance.error.message }]),
      ...(orchestrated.ok ? [] : [{ name: 'orchestrator', passed: false, output: orchestrated.error.message }]),
    ];
    const taskList = tasks.ok ? tasks.value : [], metricList = metrics.ok ? metrics.value : [];
    const total = taskList.length === 0 ? enqueued.value.length : taskList.length;
    const completed = taskList.length === 0 ? metricList.filter(item => item.outcome === 'merged').length : taskList.filter(task => task.status === 'done').length;
    const stuck = taskList.length === 0 ? metricList.filter(item => item.outcome === 'stuck').length : taskList.filter(task => task.status === 'stuck').length;
    const stats = summarize(metricList), passed = checks.filter(test => test.passed).length;
    return ok({ suite: entry.fileStem, timestamp: new Date().toISOString(), duration: Math.round((Date.now() - started) / 1000), tasksTotal: total, tasksCompleted: completed, tasksStuck: stuck, avgRounds: stats.avgRounds, avgTimeSec: stats.avgTimeSec, firstPassRate: stats.firstPassRate, acceptanceTests: checks, score: score(completed, total, passed, checks.length), metricsSnapshot: metricList });
  } finally {
    if (repoPath) {
      if (process.env.AGENTLOOP_KEEP_BENCHMARK_REPO === '1') logBenchmark(entry, `keeping repo: ${repoPath}`);
      else await rm(repoPath, { recursive: true, force: true });
    }
  }
}
