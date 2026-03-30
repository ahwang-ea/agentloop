import type { RepoInventory } from '../types/index.js';
import type { InitDraftBundle } from './init-drafts.js';

const members = (inventory: RepoInventory) => inventory.monorepo ? inventory.packages.filter(pkg => pkg.path !== '.') : [];
const modulePath = (path: string) => `${path}/MODULE.md`;
const mentions = (text: string, path: string) => text.includes(path);

function fallbackModule(inventory: RepoInventory, pkgPath: string) {
  const files = inventory.files.filter(file => file.path.startsWith(`${pkgPath}/`)).slice(0, 3).map(file => `- Example: \`${file.path}\``);
  return [
    `# ${pkgPath} module`,
    `- Path: \`${pkgPath}\``,
    '- Purpose: describe the package boundary and responsibilities here.',
    '- Primary entrypoints: list the main files or folders this package exposes.',
    '- Patterns: document the preferred conventions used inside this package.',
    '- Dependencies: call out important upstream or downstream package links.',
    '- Owned changes should stay within this package when possible.',
    '- Common/shared changes should be split into their own sequential task.',
    '- Cross-package work should be decomposed into sequential tasks.',
    ...(files.length > 0 ? files : ['- Example: add representative files here.']),
    '- Keep ARCHITECTURE.md and AGENTS.md aligned when responsibilities change.',
  ].join('\n');
}
function ensureLinks(agentsMd: string, inventory: RepoInventory) {
  const missing = members(inventory).map(pkg => modulePath(pkg.path)).filter(path => !mentions(agentsMd, path));
  return missing.length === 0 ? agentsMd : `${agentsMd.trim()}\n\n## Package guides\n${missing.map(path => `- See \`${path}\``).join('\n')}`;
}
function ensureRules(agentsMd: string) {
  return /one task\s*=\s*one package/i.test(agentsMd) && /read-only for feature agents/i.test(agentsMd)
    ? agentsMd
    : `${agentsMd.trim()}\n\n## Monorepo rules\n- One task = one package.\n- Common/shared code is read-only for feature agents.\n- Cross-package work is decomposed into sequential tasks.`;
}

export function normalizeInitDrafts(inventory: RepoInventory, drafts: InitDraftBundle): InitDraftBundle {
  if (!inventory.monorepo) return drafts;
  const modules = new Map(drafts.modules.map(module => [module.path, module.content]));
  for (const pkg of members(inventory)) if (!modules.has(modulePath(pkg.path))) modules.set(modulePath(pkg.path), fallbackModule(inventory, pkg.path));
  return {
    ...drafts,
    agentsMd: ensureRules(ensureLinks(drafts.agentsMd, inventory)),
    modules: [...modules].map(([path, content]) => ({ path, content })),
  };
}
