import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { progressiveVerify } from '../verifier.js';

const repo = () => mkdtemp(join(tmpdir(), 'agentloop-progressive-'));
const config = (repoPath: string) => ({ verifyCommand: './verify.sh' } as const);
const nodeScript = (line: string) => `node -e "require('fs').appendFileSync('log.txt', '${line}\\n')"`;

test('runs staged verify in merge mode', async () => {
  const repoPath = await repo();
  await writeFile(join(repoPath, 'test-runner.js'), "const fs=require('fs');fs.appendFileSync('log.txt', process.argv.includes('--findRelatedTests') ? 'related\\n' : 'full\\n');", 'utf-8');
  await writeFile(join(repoPath, 'package.json'), JSON.stringify({
    name: 'progressive',
    scripts: {
      typecheck: nodeScript('typecheck'),
      test: 'node test-runner.js',
      lint: nodeScript('lint'),
    },
  }), 'utf-8');
  await writeFile(join(repoPath, 'verify.sh'), await readFile(join(process.cwd(), 'templates', 'verify.sh'), 'utf-8'), 'utf-8');
  await chmod(join(repoPath, 'verify.sh'), 0o755);
  await writeFile(join(repoPath, 'src.ts'), '', 'utf-8');
  const result = await progressiveVerify(config(repoPath) as never, ['src.ts'], repoPath, true);
  expect(result.ok && result.value.pass).toBe(true);
  expect(await readFile(join(repoPath, 'log.txt'), 'utf-8')).toBe('typecheck\nrelated\nfull\nlint\n');
});

test('runs integration command only for integrate tasks', async () => {
  const repoPath = await repo();
  await writeFile(join(repoPath, 'package.json'), JSON.stringify({ name: 'progressive', scripts: { typecheck: nodeScript('typecheck') } }), 'utf-8');
  await writeFile(join(repoPath, 'verify.sh'), await readFile(join(process.cwd(), 'templates', 'verify.sh'), 'utf-8'), 'utf-8');
  await chmod(join(repoPath, 'verify.sh'), 0o755);
  const result = await progressiveVerify({ verifyCommand: './verify.sh', integrationTestCommand: nodeScript('integration') } as never, [], repoPath, false, 'integrate');
  expect(result.ok && result.value.pass).toBe(true);
  expect(await readFile(join(repoPath, 'log.txt'), 'utf-8')).toBe('typecheck\nintegration\n');
});
