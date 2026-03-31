import { access, chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { progressiveVerify, runVerify } from '../verifier.js';

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

test('passes passWithNoTests to related-test runs', async () => {
  const repoPath = await repo();
  await writeFile(join(repoPath, 'test-runner.js'), "const fs=require('fs');if(process.argv.includes('--findRelatedTests')&&!process.argv.includes('--passWithNoTests'))process.exit(1);fs.appendFileSync('log.txt', process.argv.includes('--passWithNoTests') ? 'passWithNoTests\\n' : 'full\\n');", 'utf-8');
  await writeFile(join(repoPath, 'package.json'), JSON.stringify({ name: 'progressive', scripts: { typecheck: nodeScript('typecheck'), test: 'node test-runner.js' } }), 'utf-8');
  await writeFile(join(repoPath, 'verify.sh'), await readFile(join(process.cwd(), 'templates', 'verify.sh'), 'utf-8'), 'utf-8');
  await chmod(join(repoPath, 'verify.sh'), 0o755);
  await writeFile(join(repoPath, 'src.ts'), '', 'utf-8');
  const result = await progressiveVerify(config(repoPath) as never, ['src.ts'], repoPath, false);
  expect(result.ok && result.value.pass).toBe(true);
  expect(await readFile(join(repoPath, 'log.txt'), 'utf-8')).toBe('typecheck\npassWithNoTests\n');
});

test('skips depcheck when AGENTLOOP_SKIP_DEPCHECK=1', async () => {
  const repoPath = await repo();
  const fakeBin = join(repoPath, 'fakebin');
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(fakeBin, 'npx'), "#!/usr/bin/env bash\necho called > npx.log\nexit 1\n", 'utf-8');
  await chmod(join(fakeBin, 'npx'), 0o755);
  await writeFile(join(repoPath, 'test-runner.js'), "require('fs').appendFileSync('log.txt', 'test\\n');", 'utf-8');
  await writeFile(join(repoPath, 'package.json'), JSON.stringify({ name: 'progressive', scripts: { typecheck: nodeScript('typecheck'), test: 'node test-runner.js' } }), 'utf-8');
  await writeFile(join(repoPath, 'verify.sh'), await readFile(join(process.cwd(), 'templates', 'verify.sh'), 'utf-8'), 'utf-8');
  await chmod(join(repoPath, 'verify.sh'), 0o755);
  await writeFile(join(repoPath, 'src.ts'), '', 'utf-8');
  const result = await runVerify('PATH="./fakebin:$PATH" AGENTLOOP_SKIP_DEPCHECK=1 ./verify.sh --progressive --merge src.ts', repoPath);
  expect(result.ok && result.value.pass).toBe(true);
  await expect(access(join(repoPath, 'npx.log'))).rejects.toBeDefined();
});
