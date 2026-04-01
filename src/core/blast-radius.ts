import { readFile } from 'node:fs/promises';
import { err, ok, type Result } from '../shared/result.js';
import { changedFilesOf } from './diff-parse.js';
import { discoverRepoFiles } from './scanner-discovery.js';

const SOURCE = /\.[cm]?[jt]sx?$/;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const uniq = (items: string[]) => [...new Set(items.filter(Boolean))].sort();
const importerPattern = (name: string) => new RegExp(`\\bimport\\b[\\s\\S]{0,200}?\\b${escape(name)}\\b[\\s\\S]{0,200}?\\bfrom\\b`, 'm');
const declarationPattern = (name: string) => new RegExp(`(?:export\\s+)?(?:interface|type)\\s+${escape(name)}\\b[\\s\\S]{0,400}`, 'm');
const importersOf = (name: string, body: string) => importerPattern(name).test(body);
const typeNamesOf = (body: string) => [...body.matchAll(/\b(?:export\s+)?(?:interface|type)\s+([A-Z][A-Za-z0-9_]*)/g)].map(([, name]) => name);

async function readBody(cwd: string, file: string): Promise<Result<string>> {
  try { return ok(await readFile(`${cwd}/${file}`, 'utf-8')); }
  catch (error) { return err('TRANSPORT_ERROR', `Cannot read changed type file ${file}: ${error instanceof Error ? error.message : 'unknown error'}`); }
}

function persistedType(name: string, bodies: Map<string, string>): boolean {
  return [...bodies.values()].some(body => /\bversion\??\s*[:=]/.test(body.match(declarationPattern(name))?.[0] ?? ''));
}

function collectBodies(entries: { file: string; body: Result<string> }[]): Result<Map<string, string>> {
  const bodies = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.body.ok) return entry.body;
    bodies.set(entry.file, entry.body.value);
  }
  return ok(bodies);
}

export async function traceBlastRadius(changedTypes: string[], cwd: string): Promise<Result<Map<string, string[]>>> {
  try {
    const files = await discoverRepoFiles(cwd), types = uniq(changedTypes);
    const traced = await Promise.all(types.map(async name => [name, files.filter(file => importersOf(name, file.body)).map(file => file.path).sort()] as const));
    return ok(new Map(traced));
  } catch (error) {
    return err('TRANSPORT_ERROR', `Cannot trace blast radius in ${cwd}: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

export async function buildBlastRadiusContext(diff: string, cwd: string): Promise<Result<string>> {
  const changedFiles = changedFilesOf(diff).filter(file => SOURCE.test(file));
  const entries = await Promise.all(changedFiles.map(async file => ({ file, body: await readBody(cwd, file) })));
  const collected = collectBodies(entries); if (!collected.ok) return collected;
  const bodies = collected.value;
  const changedTypes = uniq([...bodies.values()].flatMap(typeNamesOf));
  if (changedTypes.length === 0) return ok('');
  const traced = await traceBlastRadius(changedTypes, cwd); if (!traced.ok) return traced;
  const summary = changedTypes.map(name => {
    const consumers = traced.value.get(name) ?? [];
    return `- ${name}: ${consumers.length} importers${consumers.length ? ` (${consumers.slice(0, 8).join(', ')})` : ''}`;
  });
  const manifest = changedTypes.flatMap(name => {
    const consumers = traced.value.get(name) ?? [];
    return persistedType(name, bodies) && consumers.length > 5 ? [
      `- HIGH risk persisted type ${name} changed`,
      `- Consumers (${consumers.length}): ${consumers.join(', ')}`,
      '- Required: additive-only change or explicit migration before merge.',
    ] : [];
  });
  return ok(['Blast radius review:', ...summary, ...(manifest.length === 0 ? [] : ['', 'Change safety manifest:', ...manifest])].join('\n'));
}
