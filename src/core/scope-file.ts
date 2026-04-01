import { join } from 'node:path';
import type { Result } from '../shared/result.js';
import type { TaskDefinition } from '../types/index.js';
import { writeTextAtomically } from './artifact-lock.js';

type ScopePhase = 'idle' | 'write' | 'fix' | 'cleanup' | 'research' | 'docs';
interface PersistedScopeState {
  version: 1;
  phase: ScopePhase;
  updatedAt: string;
  taskId?: string;
  editableFiles: string[];
  readOnlyContext: string[];
  forbiddenFiles: string[];
}

const uniq = (items: string[]) => [...new Set(items.filter(Boolean))].sort();
const serialize = (scope: PersistedScopeState) => `${JSON.stringify(scope, null, 2)}\n`;
export const currentScopePath = (cwd: string) => join(cwd, '.agentloop', 'current-scope.json');
export const initialScopeFile = () => serialize({
  version: 1,
  phase: 'idle',
  updatedAt: new Date().toISOString(),
  editableFiles: ['**/*'],
  readOnlyContext: [],
  forbiddenFiles: [],
});

export async function writeCurrentScope(
  cwd: string,
  task: Pick<TaskDefinition, 'id' | 'scope'>,
  phase: Exclude<ScopePhase, 'idle'>,
): Promise<Result<void>> {
  return writeTextAtomically(currentScopePath(cwd), serialize({
    version: 1,
    taskId: task.id,
    phase,
    updatedAt: new Date().toISOString(),
    editableFiles: uniq(task.scope.editableFiles),
    readOnlyContext: uniq(task.scope.readOnlyContext),
    forbiddenFiles: uniq(task.scope.forbiddenFiles),
  }));
}
