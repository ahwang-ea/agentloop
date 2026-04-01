export interface DiffLine { file: string; line: number; text: string; }

const uniq = (items: string[]) => [...new Set(items.filter(Boolean))].sort();

export function changedFilesOf(diff: string): string[] {
  return uniq([...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(([, path]) => path).filter(path => path !== '/dev/null'));
}

export function addedLinesOf(diff: string): DiffLine[] {
  const added: DiffLine[] = [];
  let file = '', line = 0;
  for (const entry of diff.split('\n')) {
    if (entry.startsWith('+++ b/')) { file = entry.slice(6); continue; }
    const hunk = entry.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!file || line <= 0) continue;
    if (entry.startsWith('+') && !entry.startsWith('+++')) { added.push({ file, line, text: entry.slice(1) }); line += 1; continue; }
    if (!entry.startsWith('-') || entry.startsWith('---')) line += 1;
  }
  return added.filter(entry => entry.file !== '/dev/null');
}
