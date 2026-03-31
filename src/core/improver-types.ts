export interface ImprovementProposal {
  findings: { pattern: string; evidence: string; impact: 'high' | 'medium' | 'low' }[];
  proposals: { title: string; description: string; target: 'agents.md' | 'architecture.md' | 'verify.sh' | 'templates' | 'code' }[];
}
