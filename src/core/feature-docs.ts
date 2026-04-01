import { ok, err, type Result } from '../shared/result.js';
import type { ClaudeAdapter, TaskDefinition } from '../types/index.js';
import type { InventoryDelta } from './inventory-diff.js';
import { runVerify } from './verifier.js';
import { writeCurrentScope } from './scope-file.js';

const docTask = (feature: string, delta: InventoryDelta): TaskDefinition => ({
  id: `feature-docs:${feature}`,
  title: `Update docs for ${feature}`,
  description: `Update AGENTS.md and ARCHITECTURE.md for ${feature}. New modules: ${delta.newModules.join(', ') || 'none'}. New dependencies: ${delta.newDependencies.join(', ') || 'none'}. New env vars: ${delta.newEnvVars.join(', ') || 'none'}. Constraint changes: ${delta.constraintChanges.join('; ') || 'none'}.`,
  feature,
  type: 'implement',
  scope: { editableFiles: ['AGENTS.md', 'ARCHITECTURE.md'], readOnlyContext: [], forbiddenFiles: [] },
  acceptanceCriteria: ['Docs reflect the new modules, dependencies, env vars, and constraints.'],
  priority: 'high',
  createdAt: new Date().toISOString(),
});

export async function refreshFeatureDocs(
  claude: ClaudeAdapter, verifyCommand: string, cwd: string, feature: string, delta: InventoryDelta,
): Promise<Result<void>> {
  const task = docTask(feature, delta);
  const scope = await writeCurrentScope(cwd, task, 'docs'); if (!scope.ok) return scope;
  const session = await claude.startSession(task, cwd); if (!session.ok) return session;
  const stopped = await claude.waitForStop(session.value); if (!stopped.ok) return stopped;
  if (!stopped.value.text.trim() && stopped.value.changedFiles.length === 0) return ok(undefined);
  const verify = await runVerify(verifyCommand, cwd);
  return !verify.ok || !verify.value.pass ? err('VERIFY_FAILED', 'Feature doc refresh did not pass verify.sh') : ok(undefined);
}
