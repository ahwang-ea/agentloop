import { err, type Result } from '../shared/result.js';
import type { GitAdapter } from '../types/index.js';

export async function mergeFeatureAtomically(
  git: GitAdapter, branch: string, into: string, message: string, refresh?: () => Promise<Result<void>>,
): Promise<Result<string>> {
  const prepared = await git.prepareMerge(branch, into); if (!prepared.ok) return prepared;
  if (refresh) {
    const docs = await refresh();
    if (!docs.ok) {
      const aborted = await git.abortMerge(into);
      return aborted.ok ? docs : err(docs.error.code, `${docs.error.message}; abortMerge: ${aborted.error.message}`);
    }
  }
  const committed = await git.commitBase(message, into);
  if (committed.ok) return committed;
  const aborted = await git.abortMerge(into);
  return aborted.ok ? committed : err(committed.error.code, `${committed.error.message}; abortMerge: ${aborted.error.message}`);
}
