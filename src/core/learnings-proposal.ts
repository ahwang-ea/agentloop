import { err, ok, type Result } from '../shared/result.js';
import type { ClaudeAdapter, MetricsRecord } from '../types/index.js';

const lineCount = (text: string) => (text.replace(/\n$/, '') || '').split('\n').filter(Boolean).length;
const proposalPrompt = (agentsMd: string, entries: MetricsRecord[], retry?: string) => [
  'Propose a unified diff against the current AGENTS.md based on the recent task metrics.',
  'Return ONLY the diff. Keep the resulting AGENTS.md under 100 lines.',
  'For each proposed rule, prefer a lint rule, test helper, or type constraint over prose when possible.',
  'If adding a rule would exceed 100 lines, remove the least-valuable existing rule in the diff.',
  retry ?? '',
  '',
  'Current AGENTS.md:',
  agentsMd,
  '',
  'Recent metrics (last 20):',
  JSON.stringify(entries, null, 2),
].filter(Boolean).join('\n');

function projectedLines(current: string, diff: string): Result<number> {
  if (!/^--- .*AGENTS\.md$/m.test(diff) || !/^\+\+\+ .*AGENTS\.md$/m.test(diff)) return err('EMPTY_RESPONSE', 'Claude response was not a diff against AGENTS.md');
  let total = lineCount(current);
  for (const line of diff.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) total += 1;
    if (line.startsWith('-')) total -= 1;
  }
  return ok(total);
}

async function requestProposal(claude: Pick<ClaudeAdapter, 'chat'>, agentsMd: string, entries: MetricsRecord[], retry?: string): Promise<Result<string>> {
  const response = await claude.chat(proposalPrompt(agentsMd, entries, retry)); if (!response.ok) return response;
  return response.value.text.trim() ? ok(response.value.text.trim()) : err('EMPTY_RESPONSE', 'Claude returned no AGENTS.md proposal');
}

export async function requestCappedProposal(claude: Pick<ClaudeAdapter, 'chat'>, agentsMd: string, entries: MetricsRecord[]): Promise<Result<string>> {
  let diff = await requestProposal(claude, agentsMd, entries); if (!diff.ok) return diff;
  let projected = projectedLines(agentsMd, diff.value);
  if (!projected.ok || projected.value > 100) {
    const note = `The previous diff was invalid or projected ${projected.ok ? projected.value : 'too many'} lines. Rewrite it as a unified diff against AGENTS.md that keeps the result at 100 lines or fewer by removing the least-valuable existing rule if needed.\n\nPrevious diff:\n${diff.value}`;
    diff = await requestProposal(claude, agentsMd, entries, note); if (!diff.ok) return diff;
    projected = projectedLines(agentsMd, diff.value);
  }
  if (!projected.ok) return projected;
  return projected.value > 100 ? err('CONFIG_ERROR', `Proposed AGENTS.md update exceeds 100 lines (${projected.value})`) : diff;
}
