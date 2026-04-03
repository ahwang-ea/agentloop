import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const entryPoints = ['app', 'index', 'server', 'main'];
const moduleDirs = ['routes', 'services', 'controllers'];
const listModules = async (repoPath: string, dir: string) => {
  try {
    return (await readdir(join(repoPath, 'src', dir), { withFileTypes: true }))
      .filter(item => item.isFile() && item.name.endsWith('.ts') && !item.name.endsWith('.d.ts') && item.name !== 'index.ts')
      .map(item => item.name.slice(0, -3));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};

export async function checkIntegration(repoPath: string, goal: string): Promise<{ name: string; passed: boolean; output?: string }[]> {
  void goal;
  try {
    let entryPath = '', entry = '';
    for (const name of entryPoints) {
      entryPath = join(repoPath, 'src', `${name}.ts`);
      try { entry = await readFile(entryPath, 'utf-8'); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; entryPath = ''; }
    }
    if (!entryPath) return [{ name: 'integration: entry point', passed: false, output: 'No app entry point found' }];
    const imports = entry.split('\n').filter(line => line.trimStart().startsWith('import ')).join('\n');
    return (await Promise.all(moduleDirs.map(dir => listModules(repoPath, dir)))).flat().map(module => {
      const passed = imports.includes(`/${module}`) || imports.includes(`'${module}'`) || imports.includes(`"${module}"`);
      return passed ? { name: `integration: ${module} imported`, passed } : { name: `integration: ${module} imported`, passed, output: `Missing import in ${entryPath}` };
    });
  } catch (error) {
    return [{ name: 'integration: scan', passed: false, output: error instanceof Error ? error.message : 'unknown error' }];
  }
}
