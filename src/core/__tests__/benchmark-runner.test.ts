import { jest } from '@jest/globals';
import { err, ok } from '../../shared/result.js';
import type { BenchmarkCatalogEntry } from '../../benchmarks/types.js';
import type { AgentloopConfig } from '../../types/index.js';

const bootstrapBenchmarkRepo = jest.fn(async () => ok('/tmp/agentloop-benchmark-runner'));
const createDeps = jest.fn(async () => ok({
  queue: {
    list: async () => ok([
      { task: { id: 't1', title: 'Done', description: '', type: 'implement', scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], priority: 'medium', createdAt: '' }, status: 'done', round: 1, startedAt: '' },
      { task: { id: 't2', title: 'Queued', description: '', type: 'implement', scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], priority: 'medium', createdAt: '' }, status: 'queued', round: 0, startedAt: '' },
    ]),
  },
} as never));
const generatePlan = jest.fn(async () => ok([]));
const enqueuePlan = jest.fn(async () => ok([]));
const runOrchestrator = jest.fn(async () => err('BUDGET_EXCEEDED', 'timed out'));
const runAcceptanceTests = jest.fn(async () => ok([{ name: 'compiles', passed: true }]));
const readMetricsRecords = jest.fn(async () => ok([
  { task_id: 't1', task: 'Done', rounds: 1, timeSec: 12, reviewFindings: 0, outcome: 'merged', errors: [], files: [], timestamp: '2026-03-30T00:00:00.000Z' },
]));

await jest.unstable_mockModule('../benchmark-bootstrap.js', () => ({ bootstrapBenchmarkRepo }));
await jest.unstable_mockModule('../deps.js', () => ({ createDeps }));
await jest.unstable_mockModule('../planner.js', () => ({ generatePlan, enqueuePlan }));
await jest.unstable_mockModule('../../orchestrator.js', () => ({ runOrchestrator }));
await jest.unstable_mockModule('../benchmark-acceptance.js', () => ({ runAcceptanceTests }));
await jest.unstable_mockModule('../metrics-report.js', () => ({ readMetricsRecords }));
const { runBenchmarkSuite } = await import('../benchmark-runner.js');

beforeEach(() => {
  jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  bootstrapBenchmarkRepo.mockReset();
  createDeps.mockReset();
  generatePlan.mockReset();
  enqueuePlan.mockReset();
  runOrchestrator.mockReset();
  runAcceptanceTests.mockReset();
  readMetricsRecords.mockReset();
  bootstrapBenchmarkRepo.mockResolvedValue(ok('/tmp/agentloop-benchmark-runner'));
  createDeps.mockResolvedValue(ok({ queue: { list: async () => ok([
    { task: { id: 't1', title: 'Done', description: '', type: 'implement', scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], priority: 'medium', createdAt: '' }, status: 'done', round: 1, startedAt: '' },
    { task: { id: 't2', title: 'Queued', description: '', type: 'implement', scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], priority: 'medium', createdAt: '' }, status: 'queued', round: 0, startedAt: '' },
  ]) } } as never));
  generatePlan.mockResolvedValue(ok([]));
  enqueuePlan.mockResolvedValue(ok([]));
  runOrchestrator.mockResolvedValue(err('BUDGET_EXCEEDED', 'timed out'));
  runAcceptanceTests.mockResolvedValue(ok([{ name: 'compiles', passed: true }]));
  readMetricsRecords.mockResolvedValue(ok([
    { task_id: 't1', task: 'Done', rounds: 1, timeSec: 12, reviewFindings: 0, outcome: 'merged', errors: [], files: [], timestamp: '2026-03-30T00:00:00.000Z' },
  ]));
});

afterEach(() => {
  jest.restoreAllMocks();
});

const entry: BenchmarkCatalogEntry = {
  id: 'crm',
  fileStem: 'crm',
  suite: { name: 'CRM', goal: 'build a crm', maxTimeSec: 60, acceptanceTests: [] },
};
const config: AgentloopConfig = {
  repoPath: '.',
  baseBranch: 'main',
  branchPrefix: 'al/',
  worktreeRoot: '.worktrees',
  verifyCommand: './verify.sh',
  agentsMdPath: 'AGENTS.md',
  architectureMdPath: 'ARCHITECTURE.md',
  claudeModel: 'claude',
  codexModel: 'codex',
  codexEnabled: true,
  useCodexWriter: true,
  autoApproveResearch: false,
  convergence: { maxWallClock: 1, maxTokens: 1, stuckThreshold: 1, thrashOverlapRatio: 0.5 },
  taskSource: 'file',
  taskFilePath: 'tasks.json',
  maxParallelAgents: 2,
  maxTasksPerSession: 3,
  maxTokensPerSession: 100000,
  parallelVerify: true,
  sweepInterval: 1,
};

test('penalizes score when orchestrator fails after acceptance checks pass', async () => {
  const result = await runBenchmarkSuite(entry, config);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.version).toBe(2);
  expect(result.value.acceptanceTests).toEqual([
    { name: 'compiles', passed: true },
    { name: 'orchestrator', passed: false, output: 'timed out' },
  ]);
  expect(result.value.firstPass).toEqual({ definition: 'terminal task metrics with outcome="merged" and rounds === 1', successes: 1, consideredTasks: 1 });
  expect(result.value.tasksCompleted).toBe(1);
  expect(result.value.tasksTotal).toBe(2);
  expect(result.value.score).toBe(0.25);
  expect(result.value.runMetadata).toEqual(expect.objectContaining({ mode: 'benchmark-fast-path', depcheckSkipped: true, reviewEnabled: false, sweepEnabled: false, useCodexWriter: true, models: { claude: 'claude', codex: 'codex' }, runtime: expect.objectContaining({ node: expect.any(String), platform: process.platform, arch: process.arch }) }));
  expect(createDeps).toHaveBeenCalledWith(expect.objectContaining({
    verifyCommand: 'AGENTLOOP_SKIP_DEPCHECK=1 ./verify.sh',
    integrationTestCommand: 'npm test -- --maxWorkers=100%',
    convergence: expect.objectContaining({ stuckThreshold: 8, thrashOverlapRatio: 1.01 }),
    autoApproveFeatures: true,
    reviewEnabled: false,
    readmeTasksEnabled: false,
    sweepInterval: 0,
  }), false);
});


test('falls back to enqueued task counts when queue listing is empty', async () => {
  createDeps.mockResolvedValueOnce(ok({ queue: { list: async () => ok([]) } } as never));
  generatePlan.mockResolvedValueOnce(ok([{ planId: 'p1' }] as never));
  enqueuePlan.mockResolvedValueOnce(ok([
    { id: 't1', title: 'Done', description: '', type: 'implement', scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], priority: 'medium', createdAt: '' },
    { id: 't2', title: 'Stuck', description: '', type: 'implement', scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], priority: 'medium', createdAt: '' },
  ] as never));
  readMetricsRecords.mockResolvedValueOnce(ok([
    { task_id: 't1', task: 'Done', rounds: 1, timeSec: 12, reviewFindings: 0, outcome: 'merged', errors: [], files: [], timestamp: '2026-03-30T00:00:00.000Z' },
    { task_id: 't2', task: 'Stuck', rounds: 0, timeSec: 60, reviewFindings: 0, outcome: 'stuck', errors: ['same_error'], files: [], timestamp: '2026-03-30T00:01:00.000Z' },
  ] as never));
  const result = await runBenchmarkSuite(entry, config);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.firstPassRate).toBe(50);
  expect(result.value.firstPass).toEqual({ definition: 'terminal task metrics with outcome="merged" and rounds === 1', successes: 1, consideredTasks: 2 });
  expect(result.value.tasksTotal).toBe(2);
  expect(result.value.tasksCompleted).toBe(1);
  expect(result.value.tasksStuck).toBe(1);
});


test('retries transient planner failures before giving up', async () => {
  generatePlan
    .mockResolvedValueOnce(err('SESSION_ERROR', 'API Error: Repeated 529 Overloaded errors'))
    .mockResolvedValueOnce(err('SESSION_ERROR', 'API Error: 500 internal server error'))
    .mockResolvedValueOnce(ok([{ planId: 'p1' }] as never));
  enqueuePlan.mockResolvedValueOnce(ok([{ id: 't1', title: 'Done', description: '', type: 'implement', scope: { editableFiles: [], readOnlyContext: [], forbiddenFiles: [] }, acceptanceCriteria: [], priority: 'medium', createdAt: '' }] as never));
  createDeps.mockResolvedValueOnce(ok({ queue: { list: async () => ok([]) } } as never));
  readMetricsRecords.mockResolvedValueOnce(ok([] as never));
  runAcceptanceTests.mockResolvedValueOnce(ok([{ name: 'compiles', passed: true }]));
  runOrchestrator.mockResolvedValueOnce(ok(undefined as never));
  const result = await runBenchmarkSuite(entry, config);
  expect(result.ok).toBe(true);
  expect(generatePlan).toHaveBeenCalledTimes(3);
});
