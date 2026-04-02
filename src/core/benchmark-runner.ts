import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BenchmarkCatalogEntry, BenchmarkResult, BenchmarkRunMetadata } from '../benchmarks/types.js';
import { ok, type Result } from '../shared/result.js';
import { writeStderr } from '../shared/stderr.js';
import type { AgentloopConfig, MetricsRecord } from '../types/index.js';
import { runOrchestrator } from '../orchestrator.js';
import { runAcceptanceTests } from './benchmark-acceptance.js';
import { bootstrapBenchmarkRepo } from './benchmark-bootstrap.js';
import { runGoldenTests } from './benchmark-golden-runner.js';
import { verifyAndRetry } from './benchmark-verify-loop.js';
import { createDeps } from './deps.js';
import { readMetricsRecords } from './metrics-report.js';
import { enqueuePlan, flattenPlan, generatePlan } from './planner.js';

const round = (value: number) => Math.round(value * 100) / 100;
const firstPassDefinition = 'terminal task metrics with outcome="merged" and rounds === 1';
const score = (completed: number, total: number, passed: number, checks: number) => total === 0 || checks === 0 ? 0 : round((completed / total) * (passed / checks));
const firstPass = (metrics: MetricsRecord[]) => ({
  definition: firstPassDefinition,
  successes: metrics.filter(item => item.outcome === 'merged' && item.rounds === 1).length,
  consideredTasks: metrics.length,
});
const failed = (entry: BenchmarkCatalogEntry, started: number, output: string, metadata?: BenchmarkRunMetadata): BenchmarkResult => ({ version: 2, suite: entry.fileStem, timestamp: new Date().toISOString(), duration: Math.round((Date.now() - started) / 1000), tasksTotal: 0, tasksCompleted: 0, tasksStuck: 0, avgRounds: 0, avgTimeSec: 0, firstPassRate: 0, firstPass: firstPass([]), acceptanceTests: [{ name: 'setup', passed: false, output }], score: 0, metricsSnapshot: [], runMetadata: metadata });
const logAttempt = (entry: BenchmarkCatalogEntry, attempt: number, message: string) => writeStderr(`[benchmark:${entry.fileStem}:${attempt}] ${message}`);
const summarize = (metrics: MetricsRecord[]) => ({
  firstPass: firstPass(metrics),
  avgRounds: metrics.length === 0 ? 0 : round(metrics.reduce((sum, item) => sum + item.rounds, 0) / metrics.length),
  avgTimeSec: metrics.length === 0 ? 0 : round(metrics.reduce((sum, item) => sum + item.timeSec, 0) / metrics.length),
  firstPassRate: metrics.length === 0 ? 0 : round((firstPass(metrics).successes / metrics.length) * 100),
});
const transientPlanError = (message: string) => /api error|overloaded|internal server error|timed out/i.test(message);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, process.env.NODE_ENV === 'test' ? 1 : ms));
const attemptStaggerMs = 1_000;
const runMetadata = (config: AgentloopConfig) => ({
  mode: 'benchmark-fast-path' as const,
  depcheckSkipped: config.verifyCommand.includes('AGENTLOOP_SKIP_DEPCHECK=1'),
  reviewEnabled: config.reviewEnabled !== false,
  sweepEnabled: config.sweepInterval > 0,
  useCodexWriter: config.useCodexWriter === true,
  models: { claude: config.claudeModel, codex: config.codexModel },
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
});

const EFFORT_LEVELS = ['high', 'high', 'high', 'xhigh'] as const;
const WRITER_MODES = [true, true, true, true] as const; // useCodexWriter per attempt

const planWithRetry = async (entry: BenchmarkCatalogEntry, attempt: number, deps: Awaited<ReturnType<typeof createDeps>> extends Result<infer T> ? T : never) => {
  let planned = await generatePlan(deps, entry.suite.goal);
  for (let retry = 0; !planned.ok && retry < 2 && transientPlanError(planned.error.message); retry += 1) {
    logAttempt(entry, attempt, `planning retry ${retry + 1}/2: ${planned.error.message}`);
    await pause((retry + 1) * 5_000);
    planned = await generatePlan(deps, entry.suite.goal);
  }
  return planned;
};

interface AttemptResult { result: Result<BenchmarkResult>; repoPath: string; }

async function runSingleAttempt(entry: BenchmarkCatalogEntry, base: AgentloopConfig, attempt: number): Promise<AttemptResult> {
  const started = Date.now();
  const effort = EFFORT_LEVELS[attempt % EFFORT_LEVELS.length];
  const useCodex = WRITER_MODES[attempt % WRITER_MODES.length];
  let repoPath = '';
  try {
    const boot = await bootstrapBenchmarkRepo(entry);
    if (!boot.ok) { logAttempt(entry, attempt, `bootstrap failed: ${boot.error.message}`); return { result: ok(failed(entry, started, boot.error.message)), repoPath: '' }; }
    repoPath = boot.value;
    logAttempt(entry, attempt, `repo: ${repoPath} effort: ${effort} writer: ${useCodex ? 'codex' : 'claude'}`);
    const config: AgentloopConfig = {
      ...base, repoPath,
      worktreeRoot: `${repoPath}/.worktrees`,
      taskFilePath: `${repoPath}/tasks.json`,
      agentsMdPath: `${repoPath}/AGENTS.md`,
      architectureMdPath: `${repoPath}/ARCHITECTURE.md`,
      verifyCommand: 'AGENTLOOP_SKIP_DEPCHECK=1 ./verify.sh',
      integrationTestCommand: 'npm test -- --maxWorkers=100%',
      convergence: { ...base.convergence, stuckThreshold: Math.max(base.convergence.stuckThreshold, 8), thrashOverlapRatio: 1.01 },
      maxParallelAgents: Math.max(base.maxParallelAgents, 5),
      shotgunAgents: Math.max(base.shotgunAgents ?? 1, 1),
      useCodexWriter: useCodex,
      autoApproveResearch: true, autoApproveFeatures: true,
      reviewEnabled: false, readmeTasksEnabled: false,
      sweepInterval: 0, skipCleanup: true,
      codexReasoningEffort: effort,
    };
    const metadata = runMetadata(config);
    const deps = await createDeps(config, false);
    if (!deps.ok) { logAttempt(entry, attempt, `deps failed: ${deps.error.message}`); return { result: ok(failed(entry, started, deps.error.message, metadata)), repoPath }; }
    const planned = await planWithRetry(entry, attempt, deps.value);
    if (!planned.ok) { logAttempt(entry, attempt, `planning failed: ${planned.error.message}`); return { result: ok(failed(entry, started, planned.error.message, metadata)), repoPath }; }
    const flat = flattenPlan(planned.value);
    logAttempt(entry, attempt, `flattened ${planned.value.length} tasks to depth-2`);
    const enqueued = await enqueuePlan(deps.value.queue, flat);
    if (!enqueued.ok) { logAttempt(entry, attempt, `enqueue failed: ${enqueued.error.message}`); return { result: ok(failed(entry, started, enqueued.error.message, metadata)), repoPath }; }
    logAttempt(entry, attempt, `enqueued ${enqueued.value.length} tasks`);
    const orchestrated = await runOrchestrator(deps.value, Date.now() + (entry.suite.maxTimeSec * 1000));
    const deadline = Date.now() + Math.max(0, (entry.suite.maxTimeSec * 1000) - (Date.now() - started));
    const verify = await verifyAndRetry(repoPath, deps.value, runOrchestrator, deadline, msg => logAttempt(entry, attempt, msg));
    if (verify.retried) logAttempt(entry, attempt, `verify retry: tests ${verify.testsPassed ? 'passed' : 'still failing'}`);
    if (entry.suite.goldenTestFile) {
      const goldenDir = join(repoPath, 'src', '__tests__');
      try {
        await mkdir(goldenDir, { recursive: true });
        await writeFile(join(goldenDir, 'golden.test.ts'), entry.suite.goldenTestFile, 'utf-8');
        logAttempt(entry, attempt, 'injected golden test');
      } catch (e) {
        logAttempt(entry, attempt, `golden injection failed: ${e instanceof Error ? e.message : 'unknown error'}`);
      }
    }
    const goldenResults = entry.suite.goldenTestFile ? await runGoldenTests(repoPath) : [];
    if (goldenResults.length > 0) logAttempt(entry, attempt, `golden: ${goldenResults.filter(r => r.passed).length}/${goldenResults.length} passed`);
    const acceptance = await runAcceptanceTests(repoPath, entry.suite.acceptanceTests);
    const metrics = await readMetricsRecords({ repoPath });
    const tasks = await deps.value.queue.list();
    if (!acceptance.ok) logAttempt(entry, attempt, `acceptance failed: ${acceptance.error.message}`);
    if (!metrics.ok) logAttempt(entry, attempt, `metrics failed: ${metrics.error.message}`);
    if (!tasks.ok) logAttempt(entry, attempt, `queue failed: ${tasks.error.message}`);
    if (!orchestrated.ok) logAttempt(entry, attempt, `orchestrator failed: ${orchestrated.error.message}`);
    if (tasks.ok) {
      const counts = Object.fromEntries(tasks.value.reduce((map, task) => map.set(task.status, (map.get(task.status) ?? 0) + 1), new Map<string, number>()));
      logAttempt(entry, attempt, `queue counts: ${JSON.stringify(counts)}`);
    }
    if (metrics.ok) logAttempt(entry, attempt, `metrics count: ${metrics.value.length}`);
    const checks = [
      ...(acceptance.ok ? acceptance.value : [{ name: 'acceptance', passed: false, output: acceptance.error.message }]),
      ...goldenResults,
      ...(orchestrated.ok ? [] : [{ name: 'orchestrator', passed: false, output: orchestrated.error.message }]),
    ];
    const taskList = tasks.ok ? tasks.value : [], metricList = metrics.ok ? metrics.value : [];
    const total = taskList.length === 0 ? enqueued.value.length : taskList.length;
    const completed = taskList.length === 0 ? metricList.filter(item => item.outcome === 'merged').length : taskList.filter(task => task.status === 'done').length;
    const stuck = taskList.length === 0 ? metricList.filter(item => item.outcome === 'stuck').length : taskList.filter(task => task.status === 'stuck').length;
    const stats = summarize(metricList), passed = checks.filter(test => test.passed).length;
    const s = score(completed, total, passed, checks.length);
    logAttempt(entry, attempt, `score: ${s} (${completed}/${total} tasks, ${passed}/${checks.length} checks)`);
    return { result: ok({ version: 2, suite: entry.fileStem, timestamp: new Date().toISOString(), duration: Math.round((Date.now() - started) / 1000), tasksTotal: total, tasksCompleted: completed, tasksStuck: stuck, avgRounds: stats.avgRounds, avgTimeSec: stats.avgTimeSec, firstPassRate: stats.firstPassRate, firstPass: stats.firstPass, acceptanceTests: checks, score: s, metricsSnapshot: metricList, runMetadata: metadata }), repoPath };
  } catch {
    return { result: ok(failed(entry, started, 'unexpected error')), repoPath };
  }
}

const keepRepo = () => process.env.AGENTLOOP_KEEP_BENCHMARK_REPO === '1';
const cleanupRepos = async (repoPaths: string[], winnerPath: string, entry: BenchmarkCatalogEntry) => {
  for (const path of repoPaths) {
    if (!path || path === winnerPath) continue;
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
  if (winnerPath) {
    if (keepRepo()) writeStderr(`[benchmark:${entry.fileStem}] keeping winner repo: ${winnerPath}`);
    else await rm(winnerPath, { recursive: true, force: true }).catch(() => {});
  }
};

export async function runBenchmarkSuite(entry: BenchmarkCatalogEntry, base: AgentloopConfig): Promise<Result<BenchmarkResult>> {
  const attempts = Math.max(1, Number(process.env.AGENTLOOP_BENCHMARK_ATTEMPTS ?? '4'));
  if (attempts === 1) {
    const { result, repoPath } = await runSingleAttempt(entry, base, 0);
    if (repoPath) {
      if (keepRepo()) writeStderr(`[benchmark:${entry.fileStem}] keeping repo: ${repoPath}`);
      else await rm(repoPath, { recursive: true, force: true }).catch(() => {});
    }
    return result;
  }

  writeStderr(`[benchmark:${entry.fileStem}] racing ${attempts} parallel attempts`);
  const runners = Array.from({ length: attempts }, (_, i) =>
    pause(i * attemptStaggerMs).then(() => runSingleAttempt(entry, base, i)),
  );
  const allRepoPaths: string[] = [];

  return new Promise(resolve => {
    let settled = false, completedCount = 0;
    let best: AttemptResult | undefined;
    for (const runner of runners) {
      runner.then(attempt => {
        completedCount++;
        allRepoPaths.push(attempt.repoPath);
        if (settled) return;
        if (!best || (attempt.result.ok && (!best.result.ok || attempt.result.value.score > best.result.value.score))) best = attempt;
        if (attempt.result.ok && attempt.result.value.score > 0) {
          settled = true;
          writeStderr(`[benchmark:${entry.fileStem}] winner found (${completedCount}/${attempts}), score=${attempt.result.value.score}`);
          resolve(attempt.result);
          Promise.all(runners).then(() => cleanupRepos(allRepoPaths, attempt.repoPath, entry));
          return;
        }
        if (completedCount === attempts) {
          settled = true;
          resolve(best!.result);
          cleanupRepos(allRepoPaths, best!.repoPath, entry);
        }
      });
    }
  });
}
