import { err, ok, type Result } from '../shared/result.js';
import type { AgentloopConfig, ClaudeAdapter, TaskInput, TaskQueueAdapter } from '../types/index.js';
import { readBenchmarkResult, readBenchmarkResults, benchmarkHistory, latestBenchmarkResults } from './benchmark-results.js';
import { validateTaskInput } from './planner-validate.js';
import { extractJson } from './review-output.js';
import { readRepoFile } from './repo-file.js';
import type { ImprovementProposal } from './improver-types.js';

export interface ImproverDeps { claude: Pick<ClaudeAdapter, 'chat'>; queue: TaskQueueAdapter; config: Pick<AgentloopConfig, 'repoPath' | 'agentsMdPath' | 'architectureMdPath'>; }
export interface ImprovementAnalysis { results: object[]; history: Array<[string, object[]]>; proposal: ImprovementProposal; }
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()) : [];
const parse = (raw: string): Result<ImprovementProposal> => {
  const json = extractJson(raw); if (!json) return err('SESSION_ERROR', 'Improver returned no JSON');
  let parsed: unknown; try { parsed = JSON.parse(json); } catch { return err('SESSION_ERROR', 'Improver returned invalid JSON'); }
  const value = parsed as Partial<ImprovementProposal>;
  if (!Array.isArray(value.findings) || !Array.isArray(value.proposals)) return err('SESSION_ERROR', 'Improver output must include findings and proposals');
  return ok({
    findings: value.findings.map(item => ({ pattern: text((item as Record<string, unknown>).pattern), evidence: text((item as Record<string, unknown>).evidence), impact: text((item as Record<string, unknown>).impact) as ImprovementProposal['findings'][number]['impact'] })),
    proposals: value.proposals.map(item => ({ title: text((item as Record<string, unknown>).title), description: text((item as Record<string, unknown>).description), target: text((item as Record<string, unknown>).target) as ImprovementProposal['proposals'][number]['target'] })),
  });
};
const parseTask = (raw: string): Result<TaskInput> => {
  const json = extractJson(raw); if (!json) return err('SESSION_ERROR', 'Task generator returned no JSON');
  let parsed: unknown; try { parsed = JSON.parse(json); } catch { return err('SESSION_ERROR', 'Task generator returned invalid JSON'); }
  const value = parsed as Partial<TaskInput> & { scope?: Partial<TaskInput['scope']> };
  const task: TaskInput = { title: text(value.title), description: text(value.description), feature: text(value.feature) || undefined, type: text(value.type) as TaskInput['type'], priority: text(value.priority) as TaskInput['priority'], acceptanceCriteria: list(value.acceptanceCriteria), scope: { editableFiles: list(value.scope?.editableFiles), readOnlyContext: list(value.scope?.readOnlyContext), forbiddenFiles: list(value.scope?.forbiddenFiles) } };
  const issues = validateTaskInput({ type: task.type, priority: task.priority, scope: task.scope, acceptanceCriteria: task.acceptanceCriteria });
  return issues.length === 0 ? ok(task) : err('CONFIG_ERROR', issues.join('; '));
};

export async function analyzeImprovements(d: ImproverDeps, resultPath?: string): Promise<Result<ImprovementAnalysis>> {
  const [agents, architecture, all] = await Promise.all([readRepoFile(d.config.repoPath, d.config.agentsMdPath), readRepoFile(d.config.repoPath, d.config.architectureMdPath), readBenchmarkResults()]);
  if (!agents.ok) return agents; if (!architecture.ok) return architecture; if (!all.ok) return all;
  const selected = resultPath ? await readBenchmarkResult(resultPath) : ok(latestBenchmarkResults(all.value)); if (!selected.ok) return selected;
  const prompt = [
    'Analyze these benchmark results and propose improvements. Return ONLY JSON.',
    'Schema: { findings: [{ pattern, evidence, impact }], proposals: [{ title, description, target }] }.',
    'Targets: agents.md | architecture.md | verify.sh | templates | code. Order proposals to align with findings when possible.',
    '', 'Results JSON:', JSON.stringify(selected.value, null, 2), '', 'Recent history by suite:', JSON.stringify(Object.fromEntries(benchmarkHistory(all.value)), null, 2),
    ...(agents.value ? ['', 'AGENTS.md:', agents.value] : []), ...(architecture.value ? ['', 'ARCHITECTURE.md:', architecture.value] : []),
  ].join('\n');
  const response = await d.claude.chat(prompt); if (!response.ok) return err(response.error.code, `Improvement analysis failed: ${response.error.message}`);
  const proposal = parse(response.value.text); if (!proposal.ok) return proposal;
  return ok({ results: Array.isArray(selected.value) ? selected.value : [selected.value], history: benchmarkHistory(all.value), proposal: proposal.value });
}

export async function generateImprovementTask(d: ImproverDeps, proposal: ImprovementProposal['proposals'][number]): Promise<Result<TaskInput>> {
  const prompt = [
    'Convert this improvement proposal into one TaskInput JSON object.',
    'Fields: title, description, type, scope(editableFiles, readOnlyContext, forbiddenFiles), acceptanceCriteria, priority, optional feature.',
    'Use repo-relative paths. implement/integrate tasks need acceptanceCriteria. scope.editableFiles must be non-empty.',
    '', `Title: ${proposal.title}`, `Target: ${proposal.target}`, proposal.description,
  ].join('\n');
  const response = await d.claude.chat(prompt); if (!response.ok) return err(response.error.code, `Task generation failed: ${response.error.message}`);
  return parseTask(response.value.text);
}
