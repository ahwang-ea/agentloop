import { createInterface } from 'node:readline/promises';
import { err, ok, type Result } from '../shared/result.js';
import type { TaskDefinition, TaskInput, TaskQueueAdapter } from '../types/index.js';
import { benchmarkTrend } from './benchmark-results.js';
import type { ImprovementAnalysis, ImproverDeps } from './improver.js';
import type { ImprovementProposal } from './improver-types.js';

const impacts: ImprovementProposal['findings'][number]['impact'][] = ['high', 'medium', 'low'];
const rate = (completed: number, total: number) => total === 0 ? 0 : (completed / total) * 100;

export const formatImprovementAnalysis = (analysis: ImprovementAnalysis) => [
  ...impacts.flatMap(impact => {
    const group = analysis.proposal.findings.map((finding, index) => ({ finding, proposal: analysis.proposal.proposals[index] })).filter(item => item.finding.impact === impact);
    const lines = group.flatMap(item => [
      `- ${item.finding.pattern}`,
      `  Evidence: ${item.finding.evidence}`,
      ...(item.proposal ? [`  → Proposal: ${item.proposal.title} [${item.proposal.target}]`] : []),
    ]);
    return lines.length === 0 ? [] : [`${impact.toUpperCase()} IMPACT:`, ...lines, ''];
  }),
  ...analysis.history.flatMap(([suite, results]) => results.length < 3 ? [] : [
    `${suite} trend: ${benchmarkTrend(results.map(item => Number((item as { score: number }).score)), 'ratio')}`,
    `Stuck rate trend: ${benchmarkTrend(results.map(item => rate(Number((item as { tasksStuck: number }).tasksStuck), Number((item as { tasksTotal: number }).tasksTotal))), 'percent')}`,
    `Avg rounds trend: ${benchmarkTrend(results.map(item => Number((item as { avgRounds: number }).avgRounds)), 'number')}`,
  ]),
].filter(Boolean).join('\n');

export async function applyImprovementTasks(
  analysis: ImprovementAnalysis,
  deps: ImproverDeps & { queue: TaskQueueAdapter },
  build: (deps: ImproverDeps, proposal: ImprovementProposal['proposals'][number]) => Promise<Result<TaskInput>>,
): Promise<Result<TaskDefinition[]>> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return err('CONFIG_ERROR', '--apply requires a TTY');
  const rl = createInterface({ input: process.stdin, output: process.stdout }), created: TaskDefinition[] = [];
  try {
    for (const proposal of analysis.proposal.proposals) {
      const answer = (await rl.question(`Create a task for this improvement? (y/n/skip) ${proposal.title} `)).trim().toLowerCase();
      if (answer !== 'y') continue;
      const task = await build(deps, proposal); if (!task.ok) { console.error(`Skipped ${proposal.title}: ${task.error.message}`); continue; }
      const added = await deps.queue.add(task.value); if (!added.ok) { console.error(`Skipped ${proposal.title}: ${added.error.message}`); continue; }
      created.push(added.value);
    }
    return ok(created);
  } finally { rl.close(); }
}
