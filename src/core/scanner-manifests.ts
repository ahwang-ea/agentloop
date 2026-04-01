import { dirname } from 'node:path';
import type { InventoryDependencyFile, InventoryPackage } from '../types/index.js';

interface PackageJsonShape {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

export interface ParsedPackageJson {
  package?: InventoryPackage;
  dependencies?: InventoryDependencyFile;
  frameworks: string[];
  workspaces: boolean;
}

const TOML_SECTION = /^\s*\[([^\]]+)\]\s*$/;
const TOML_KEY = /^\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*=/;
const TOML_ARRAY = /^\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*=\s*\[/;
const pyprojectSection = (line: string) => line.match(TOML_SECTION)?.[1].trim();
const pyprojectRequirement = (value: string) => value.match(/^\s*([A-Za-z][A-Za-z0-9_.-]*)(?:\[[^\]]+\])?/)?.[1];
const poetrySection = (name: string) => name === 'tool.poetry.dependencies' || name === 'tool.poetry.dev-dependencies' || /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(name);
const arraySection = (name: string) => name === 'project' || name === 'project.optional-dependencies';
const pyprojectArrayItems = (body: string) => {
  const items: string[] = [];
  let depth = 0, quote = '', value = '', escape = false;
  for (const char of body) {
    if (quote) {
      if (escape) { value += char; escape = false; continue; }
      if (char === '\\') { escape = true; continue; }
      if (char === quote) { items.push(value); quote = ''; value = ''; continue; }
      value += char;
      continue;
    }
    if (char === '"' || char === "'") { if (depth > 0) { quote = char; value = ''; } continue; }
    if (char === '[') depth += 1;
    if (char === ']') depth -= 1;
  }
  return items;
};
const addPyprojectArray = (dependencies: Set<string>, body: string) => pyprojectArrayItems(body).map(pyprojectRequirement).filter(Boolean).forEach(name => dependencies.add(name as string));
const arrayDepth = (line: string) => {
  let depth = 0, quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === '\\') { index += 1; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '[') depth += 1;
    if (char === ']') depth -= 1;
  }
  return depth;
};

export function parsePackageJson(path: string, body: string): ParsedPackageJson {
  try {
    const json = JSON.parse(body) as PackageJsonShape;
    const dependencies = Object.keys({ ...(json.dependencies ?? {}), ...(json.devDependencies ?? {}) });
    return {
      package: { name: json.name ?? path, path: dirname(path) === '.' ? '.' : dirname(path) },
      dependencies: { path, kind: 'package.json', dependencies },
      frameworks: ['jest', 'vitest', 'mocha'].filter(name => dependencies.includes(name)),
      workspaces: Array.isArray(json.workspaces) || Array.isArray(json.workspaces?.packages),
    };
  } catch { return { frameworks: [], workspaces: false }; }
}

export function parsePyprojectToml(path: string, body: string): InventoryDependencyFile {
  const dependencies = new Set<string>();
  let section = '', array = '', depth = 0;
  for (const line of body.split('\n')) {
    const nextSection = pyprojectSection(line);
    if (nextSection) { section = nextSection; array = ''; depth = 0; continue; }
    if (poetrySection(section)) {
      const name = line.match(TOML_KEY)?.[1];
      if (name && name !== 'python') dependencies.add(name);
      continue;
    }
    if (!array && arraySection(section)) {
      const key = line.match(TOML_ARRAY)?.[1];
      if (key && (section !== 'project' || key === 'dependencies')) { array = line; depth = arrayDepth(line); }
    } else if (array) {
      array += `\n${line}`;
      depth += arrayDepth(line);
    }
    if (array && depth <= 0) { addPyprojectArray(dependencies, array); array = ''; depth = 0; }
  }
  return { path, kind: 'pyproject.toml', dependencies: [...dependencies] };
}
