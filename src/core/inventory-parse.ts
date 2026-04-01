import { ok, type Result } from '../shared/result.js';
import type { RepoInventory } from '../types/index.js';
import { asBoolean, asNumber, asObject, asObjectArray, asString, asStringArray, malformed, parseJson, unwrapVersioned } from './persisted-json.js';

const filesOf = (value: unknown, path: string): Result<RepoInventory['files']> => {
  const items = asObjectArray(value); if (!items) return malformed(path, 'invalid files');
  const files: RepoInventory['files'] = [];
  for (const item of items) { const file = asString(item.path), lines = asNumber(item.lines); if (file == null || lines == null) return malformed(path, 'invalid file entry'); files.push({ path: file, lines }); }
  return ok(files);
};
const docsOf = (value: unknown, path: string): Result<RepoInventory['docs']> => {
  const items = asObjectArray(value); if (!items) return malformed(path, 'invalid docs');
  const docs: RepoInventory['docs'] = [];
  for (const item of items) { const file = asString(item.path), modifiedAt = asString(item.modifiedAt); if (file == null || modifiedAt == null) return malformed(path, 'invalid doc entry'); docs.push({ path: file, modifiedAt }); }
  return ok(docs);
};
const packagesOf = (value: unknown, path: string): Result<RepoInventory['packages']> => {
  const items = asObjectArray(value); if (!items) return malformed(path, 'invalid packages');
  const packages: RepoInventory['packages'] = [];
  for (const item of items) { const name = asString(item.name), packagePath = asString(item.path); if (name == null || packagePath == null) return malformed(path, 'invalid package entry'); packages.push({ name, path: packagePath }); }
  return ok(packages);
};
const depsOf = (value: unknown, path: string): Result<RepoInventory['dependencies']> => {
  const items = asObjectArray(value); if (!items) return malformed(path, 'invalid dependencies');
  const dependencies: RepoInventory['dependencies'] = [];
  for (const item of items) { const file = asString(item.path), kind = asString(item.kind), names = asStringArray(item.dependencies); if (file == null || !names || (kind !== 'package.json' && kind !== 'pyproject.toml')) return malformed(path, 'invalid dependency entry'); dependencies.push({ path: file, kind, dependencies: names }); }
  return ok(dependencies);
};
const importsOf = (value: unknown, path: string): Result<RepoInventory['importFrequency']> => {
  const items = asObjectArray(value); if (!items) return malformed(path, 'invalid importFrequency');
  const frequencies: RepoInventory['importFrequency'] = [];
  for (const item of items) { const file = asString(item.path), importedBy = asNumber(item.importedBy); if (file == null || importedBy == null) return malformed(path, 'invalid import entry'); frequencies.push({ path: file, importedBy }); }
  return ok(frequencies);
};

export function parseInventory(raw: string, path: string): Result<RepoInventory> {
  const parsed = parseJson(raw, path); if (!parsed.ok) return parsed;
  const wrapper = asObject(parsed.value), root = asObject(unwrapVersioned(parsed.value, 'inventory')); if (!root) return malformed(path, 'inventory must be an object');
  const files = filesOf(root.files, path), packages = packagesOf(root.packages, path), docs = docsOf(root.docs, path), dependencies = depsOf(root.dependencies, path), importFrequency = importsOf(root.importFrequency, path);
  const tests = asObject(root.tests), patterns = asObject(root.patterns), env = asObject(root.env), scannedAt = asString(root.scannedAt), monorepo = asBoolean(root.monorepo), crossPackageImports = asStringArray(root.crossPackageImports), frameworks = asStringArray(tests?.frameworks), testCount = asNumber(tests?.count), oversizedFiles = asStringArray(root.oversizedFiles), ci = asStringArray(root.ci), example = asStringArray(env?.example), referenced = asStringArray(env?.referenced), missingInExample = asStringArray(env?.missingInExample), unusedInExample = asStringArray(env?.unusedInExample), resultCount = asNumber(patterns?.resultCount), tryCatchCount = asNumber(patterns?.tryCatchCount), serviceFileCount = asNumber(patterns?.serviceFileCount), controllerFileCount = asNumber(patterns?.controllerFileCount);
  return scannedAt != null && monorepo != null && crossPackageImports && files.ok && packages.ok && docs.ok && dependencies.ok && importFrequency.ok && frameworks && testCount != null && example && referenced && missingInExample && unusedInExample && oversizedFiles && ci && resultCount != null && tryCatchCount != null && serviceFileCount != null && controllerFileCount != null
    ? ok({ version: root.version === 1 || wrapper?.version === 1 ? 1 : undefined, scannedAt, files: files.value, monorepo, packages: packages.value, crossPackageImports, patterns: { resultCount, tryCatchCount, serviceFileCount, controllerFileCount }, tests: { frameworks, count: testCount }, docs: docs.value, dependencies: dependencies.value, env: { example, referenced, missingInExample, unusedInExample }, oversizedFiles, ci, importFrequency: importFrequency.value })
    : malformed(path, 'invalid inventory structure');
}
