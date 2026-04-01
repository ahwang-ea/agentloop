import type { RepoInventory } from '../types/index.js';
import type { DiscoveredRepoFile } from './scanner-discovery.js';
import { resolveRepoImport } from './scanner-discovery.js';
import { addPackageJson, addPyproject, createInventoryBuildState, importsOfBody, recordImportResolution, recordInventoryFile, toRepoInventory } from './scanner-assembly.js';
import { parsePackageJson, parsePyprojectToml } from './scanner-manifests.js';

export async function buildInventory(repoPath: string, discoveredFiles: DiscoveredRepoFile[]): Promise<RepoInventory> {
  const state = createInventoryBuildState();
  for (const file of discoveredFiles) {
    recordInventoryFile(state, file);
    if (file.path.endsWith('package.json')) addPackageJson(state, parsePackageJson(file.path, file.body));
    if (file.path.endsWith('pyproject.toml')) addPyproject(state, parsePyprojectToml(file.path, file.body), file.body);
  }
  for (const [path, body] of state.bodies) {
    for (const specifier of importsOfBody(body)) {
      recordImportResolution(state, path, specifier, await resolveRepoImport(repoPath, path, specifier));
    }
  }
  return toRepoInventory(state, discoveredFiles);
}
