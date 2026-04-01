import { readFile } from 'node:fs/promises';
import { ok, err, type Result } from '../shared/result.js';
import type { ReviewFinding } from '../types/index.js';
import { changedFilesOf, addedLinesOf } from './diff-parse.js';
import { runParallelChecks, type ConcernCheck } from './parallel-check.js';
import { discoverRepoFiles } from './scanner-discovery.js';

const MAX_FILE_LINES = 150;
const TEST = /(\.test|\.spec)\.[cm]?[jt]sx?$/;
const SOURCE = /\.[cm]?[jt]sx?$/;
const COMMENT_ONLY = /^\s*(?:\/\/|\/\*|\*\/|\*)/;
const issue = (description: string, topicKey: string, file?: string, line?: number): ReviewFinding => ({ reviewer: 'deterministic-check', severity: 'issue', description, topicKey, action: 'change', file, line });
const suggestion = (description: string, topicKey: string, file?: string, line?: number): ReviewFinding => ({ reviewer: 'deterministic-check', severity: 'suggestion', description, topicKey, action: 'change', file, line });
const changedSources = (diff: string) => changedFilesOf(diff).filter(file => SOURCE.test(file) && !TEST.test(file) && !file.endsWith('.d.ts'));
const dirOf = (file: string) => file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
const lastSegment = (file: string) => file.split('/').pop() ?? file;
const fileStem = (file: string) => file.replace(/\.[^.]+$/, '');
const sourceCoverageKeys = (file: string) => {
  const stem = fileStem(file);
  if (!stem.endsWith('/index')) return [stem];
  const dir = dirOf(stem), name = lastSegment(dir);
  return name ? [stem, `${dir}/${name}`] : [stem];
};
const testCoverageKeys = (file: string) => [...new Set([file.replace(TEST, ''), file.replace(TEST, '').replace('/__tests__/', '/')])];
const readBody = async (cwd: string, file: string) => {
  try { return ok(await readFile(`${cwd}/${file}`, 'utf-8')); }
  catch (error) { return err('TRANSPORT_ERROR', `Cannot read changed file ${file}: ${error instanceof Error ? error.message : 'unknown error'}`); }
};
const count = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length;
const exportNames = (body: string) => [...body.matchAll(/export\s+(?:const|function|class|type|interface)\s+([A-Za-z_$][\w$]*)/g)].map(([, name]) => name);
const stripNoise = (text: string) => COMMENT_ONLY.test(text)
  ? ''
  : text
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?\*\//g, ' ')
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, ' ')
    .trim();
const splitTopLevel = (text: string) => {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if ('([{<'.includes(char)) depth += 1;
    else if (')]}>'.includes(char)) depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  parts.push(text.slice(start));
  return parts;
};
const hasTopLevelType = (text: string) => {
  let depth = 0;
  for (const char of text) {
    if ('([{<'.includes(char)) depth += 1;
    else if (')]}>'.includes(char)) depth = Math.max(0, depth - 1);
    else if (char === '=' && depth === 0) break;
    else if (char === ':' && depth === 0) return true;
  }
  return false;
};
const functionParams = (text: string) =>
  text.match(/^\s*(?:export\s+default\s+)?(?:export\s+)?(?:async\s+)?function\b(?:\s+\w+)?(?:\s*<[^>]+>)?\s*\(([^)]*)\)/)?.[1]
  ?? text.match(/^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:<[^>]+>\s*)?\(([^)]*)\)\s*=>/)?.[1]
  ?? text.match(/^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?([A-Za-z_$][\w$]*)\s*=>/)?.[1];
const aliasLine = (text: string) => /^\s*(?:import|export)\b[^;]*\{[^}]*\bas\b[^}]*\}\s*(?:from\b|;|$)/.test(text);
const hasUntypedParams = (text: string) => {
  const params = functionParams(text);
  return params != null && splitTopLevel(params).some(param => param.trim() !== '' && !hasTopLevelType(param));
};

function typeSafetyCheck(): ConcernCheck {
  return {
    name: 'type-safety',
    async check(diff) {
      return ok(addedLinesOf(diff)
        .filter(line => {
          if (!SOURCE.test(line.file)) return false;
          const code = stripNoise(line.text);
          return code !== '' && (/\bany\b/.test(code) || (!aliasLine(code) && /\bas\s+(?!const\b)/.test(code)) || hasUntypedParams(code));
        })
        .map(line => issue('Tighten changed typing; avoid `any`, broad casts, and untyped parameters.', 'type_safety', line.file, line.line)));
    },
  };
}

function coverageCheck(): ConcernCheck {
  return {
    name: 'test-coverage',
    async check(diff) {
      const changed = new Set(changedFilesOf(diff).filter(file => TEST.test(file)).flatMap(testCoverageKeys));
      return ok(changedSources(diff)
        .filter(file => !sourceCoverageKeys(file).some(key => changed.has(key)))
        .map(file => issue('Changed source file has no matching test change in this diff.', 'test_coverage', file)));
    },
  };
}

function fileSizeCheck(cwd: string): ConcernCheck {
  return {
    name: 'file-size',
    async check(diff) {
      const findings: ReviewFinding[] = [];
      for (const file of changedFilesOf(diff)) {
        const body = await readBody(cwd, file); if (!body.ok) return body;
        if (body.value.split('\n').length > MAX_FILE_LINES) findings.push(issue(`Changed file exceeds ${MAX_FILE_LINES} lines; split it or justify the size.`, 'file_size', file));
      }
      return ok(findings);
    },
  };
}

function patternDriftCheck(cwd: string): ConcernCheck {
  return {
    name: 'pattern-drift',
    async check(diff) {
      const findings: ReviewFinding[] = [];
      for (const file of changedSources(diff)) {
        const body = await readBody(cwd, file); if (!body.ok) return body;
        if (count(body.value, /Result</g) < count(body.value, /\btry\s*\{/g)) findings.push(issue('Changed file drifts toward try/catch instead of Result<T>.', 'pattern_drift', file));
      }
      return ok(findings);
    },
  };
}

function deadCodeCheck(cwd: string): ConcernCheck {
  return {
    name: 'dead-code',
    async check(diff) {
      const files = await discoverRepoFiles(cwd), bodies = new Map(files.map(file => [file.path, file.body]));
      const findings = changedSources(diff).flatMap(file => exportNames(bodies.get(file) ?? '').flatMap(name => {
        const used = files.some(candidate => candidate.path !== file && new RegExp(`\\b${name}\\b`).test(candidate.body));
        return used ? [] : [suggestion(`Export ${name} does not appear to be used elsewhere in the repo.`, 'dead_code', file)];
      }));
      return ok(findings);
    },
  };
}

export async function runDeterministicChecks(cwd: string, diff: string, context: string): Promise<Result<ReviewFinding[]>> {
  const checks: ConcernCheck[] = [typeSafetyCheck(), coverageCheck(), fileSizeCheck(cwd), patternDriftCheck(cwd), deadCodeCheck(cwd)];
  return runParallelChecks(checks, diff, context);
}
