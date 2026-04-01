import { err, ok, type Result } from '../shared/result.js';
import type { ReviewFinding } from '../types/index.js';

export interface ConcernCheck {
  name: string;
  check: (diff: string, context: string) => Promise<Result<ReviewFinding[]>>;
}

export async function runParallelChecks(
  checks: ConcernCheck[], diff: string, context: string,
): Promise<Result<ReviewFinding[]>> {
  const results = await Promise.all(checks.map(async item => {
    try { return { name: item.name, result: await item.check(diff, context) }; }
    catch (error) { return { name: item.name, result: err('UNKNOWN', error instanceof Error ? error.message : 'unknown error') }; }
  }));
  const failed = results.find(item => !item.result.ok);
  return failed && !failed.result.ok
    ? err(failed.result.error.code, `Concern check ${failed.name} failed: ${failed.result.error.message}`, failed.result.error.details)
    : ok(results.flatMap(item => item.result.ok ? item.result.value : []));
}
