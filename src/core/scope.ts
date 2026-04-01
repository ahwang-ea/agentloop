import { ok, type Result } from '../shared/result.js';
import type { TaskScope } from '../types/index.js';

const uniq = (items: string[]) => [...new Set(items.filter(Boolean))].sort();
const glob = (pattern: string) => new RegExp(`^${pattern
  .replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*/g, '.*')
  .replace(/\?/g, '.')}$`);
const matches = (path: string, patterns: string[]) => patterns.some(pattern => glob(pattern).test(path));

function parsePaths(diff: string): string[] {
  const headers = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(([, path]) => path).filter(path => path !== '/dev/null');
  if (headers.length > 0) return uniq(headers);
  return uniq(diff.split('\n').map(line => line.trim())
    .filter(line => line && !/^(@@|diff --git|index |--- )/.test(line))
    .map(line => line.replace(/^[A-Z?]{1,2}\s+/, '').replace(/^[ab]\//, '')));
}

const scratchPatterns = [/\.tsbuildinfo$/, /\.bak\d*$/];
const isScratch = (file: string) => scratchPatterns.some(pattern => pattern.test(file));

export function checkScope(diff: string, scope: TaskScope): Result<string[]> {
  const files = parsePaths(diff);
  return ok(files.filter(file => !isScratch(file) && (matches(file, scope.forbiddenFiles) || !matches(file, scope.editableFiles))));
}
