const rules = [
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
  'SPEED: Generate 4-5 self-contained tasks. Each entity task must include its service, route handler, AND tests so it compiles independently.',
  'SPEED: Dependency depth MUST be exactly 2. One foundation task (types+schemas+db, no deps). ALL remaining tasks depend ONLY on foundation and run fully in parallel.',
  'SPEED: Do NOT create a final wiring/integration task that depends on entity tasks. The app wiring task depends only on foundation. Entity route files are mounted by the app task via dynamic imports or the app task creates stubs.',
  'SPEED: Each entity task writes ALL files it needs to compile: service + route + test. It must pass typecheck independently.',
  'SPEED: NO TWO TASKS may write to the same file. Each task must own exclusive files. Do not create shared barrel files (index.ts, routes/index.ts) in entity tasks — only the foundation or app wiring task may create shared barrels.',
  'SPEED: Keep entity tasks SMALL — prefer 2-3 files per task (one service, one route, one test). Fewer files = faster completion.',
];

const issueBlock = (issues: string[]) => issues.length === 0 ? [] : ['', 'Fix these validation issues from your last attempt:', ...issues.map(issue => `- ${issue}`)];
const shouldLog = () => process.env.AGENTLOOP_LOG_PLAN === '1' || process.env.AGENTLOOP_LOG_VERIFY === '1';

export const jsonOnlyIssues = ['Return ONLY a raw JSON array. Do not include markdown fences, prose, or commentary.'];

export const prompt = (goal: string, tree: string[], agents?: string, architecture?: string, issues: string[] = []) => [
  'Plan work for this repository. Return ONLY JSON: an ordered array of tasks.',
  'Do not include markdown fences, prose, or explanations before or after the JSON.',
  ...rules,
  ...issueBlock(issues),
  '', 'Goal:', goal, '', 'File tree:', tree.length === 0 ? '(empty repo)' : tree.join('\n'),
  ...(agents ? ['', 'AGENTS.md:', agents] : []), ...(architecture ? ['', 'ARCHITECTURE.md:', architecture] : []),
].join('\n');

export const compactPrompt = (goal: string, tree: string[], issues: string[] = []) => [
  'Plan work for this repository. Return ONLY JSON: an ordered array of tasks.',
  'Do not include markdown fences, prose, or explanations before or after the JSON.',
  ...rules,
  'Example: [{"planId":"plan-1","title":"Define shared types","description":"Create shared Result and domain types.","type":"implement","priority":"high","scope":{"editableFiles":["src/types/*.ts"],"readOnlyContext":["AGENTS.md","ARCHITECTURE.md"],"forbiddenFiles":["package.json"]},"acceptanceCriteria":["src/types/index.ts exports shared types","npm test passes"],"dependsOn":[]}].',
  ...issueBlock(issues),
  '', 'Goal:', goal, '', 'File tree:', tree.length === 0 ? '(empty repo)' : tree.join('\n'),
].join('\n');

export const logPlan = (stage: string, raw: string, stopReason: string, issue: string) => {
  if (!shouldLog()) return;
  console.error(`[planner:${stage}] stop=${stopReason} issue=${issue} raw=${raw.trim().replace(/\s+/g, ' ').slice(0, 400)}`);
};

export const logValidationIssues = (issues: string[]) => {
  if (!shouldLog()) return;
  console.error(`[planner:validation-issues] ${issues.join(' | ')}`);
};
