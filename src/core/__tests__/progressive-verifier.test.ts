import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { progressiveVerify, runVerify } from '../verifier.js';

jest.setTimeout(15_000);

const repos: string[] = [];
const repo = async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'agentloop-progressive-'));
  repos.push(repoPath);
  return repoPath;
};
const config = (repoPath: string) => ({ verifyCommand: './verify.sh' } as const);
const nodeScript = (line: string) => `node -e "require('fs').appendFileSync('log.txt', '${line}\\n')"`;
const repoVerify = () => readFile(join(process.cwd(), 'verify.sh'), 'utf-8');
const templateVerify = () => readFile(join(process.cwd(), 'templates', 'verify.sh'), 'utf-8');
const writeVerify = async (repoPath: string) => {
  await writeFile(join(repoPath, 'verify.sh'), await templateVerify(), 'utf-8');
  await chmod(join(repoPath, 'verify.sh'), 0o755);
};
const writeRepoVerify = async (repoPath: string) => {
  await writeFile(join(repoPath, 'verify.sh'), await repoVerify(), 'utf-8');
  await chmod(join(repoPath, 'verify.sh'), 0o755);
};

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(repos.splice(0).map((repoPath) => rm(repoPath, { recursive: true, force: true })));
});

test('runs staged verify in merge mode with parallel test workers', async () => {
  const repoPath = await repo();
  await writeFile(join(repoPath, 'test-runner.js'), "const fs=require('fs');const mode=process.argv.includes('--findRelatedTests')?'related':'full';if(!process.argv.includes('--maxWorkers=100%'))process.exit(1);fs.appendFileSync('log.txt', mode + ':parallel\\n');", 'utf-8');
  await writeFile(join(repoPath, 'package.json'), JSON.stringify({
    name: 'progressive',
    scripts: {
      typecheck: nodeScript('typecheck'),
      test: 'node test-runner.js',
      lint: nodeScript('lint'),
    },
  }), 'utf-8');
  await writeVerify(repoPath);
  await writeFile(join(repoPath, 'src.ts'), '', 'utf-8');
  const result = await progressiveVerify(config(repoPath) as never, ['src.ts'], repoPath, true);
  expect(result.ok && result.value.pass).toBe(true);
  expect(await readFile(join(repoPath, 'log.txt'), 'utf-8')).toBe('typecheck\nrelated:parallel\nfull:parallel\nlint\n');
});

test('does not duplicate maxWorkers when test already sets it', async () => {
  const repoPath = await repo();
  await writeFile(join(repoPath, 'test-runner.js'), "const fs=require('fs');if(process.argv.filter(arg=>arg==='--maxWorkers=100%').length!==1)process.exit(1);fs.appendFileSync('log.txt', process.argv.includes('--findRelatedTests') ? 'related\\n' : 'full\\n');", 'utf-8');
  await writeFile(join(repoPath, 'package.json'), JSON.stringify({
    name: 'progressive',
    scripts: {
      typecheck: nodeScript('typecheck'),
      test: 'node test-runner.js --maxWorkers=100%',
      lint: nodeScript('lint'),
    },
  }), 'utf-8');
  await writeRepoVerify(repoPath);
  await writeFile(join(repoPath, 'src.ts'), '', 'utf-8');
  const result = await runVerify('./verify.sh --progressive --merge src.ts', repoPath);
  expect(result.ok && result.value.pass).toBe(true);
  expect(await readFile(join(repoPath, 'log.txt'), 'utf-8')).toBe('typecheck\nrelated\nfull\nlint\n');
});

test('runs integration command only for integrate tasks', async () => {
  const repoPath = await repo();
  await writeFile(join(repoPath, 'package.json'), JSON.stringify({ name: 'progressive', scripts: { typecheck: nodeScript('typecheck') } }), 'utf-8');
  await writeVerify(repoPath);
  const result = await progressiveVerify({ verifyCommand: './verify.sh', integrationTestCommand: nodeScript('integration') } as never, [], repoPath, false, 'integrate');
  expect(result.ok && result.value.pass).toBe(true);
  expect(await readFile(join(repoPath, 'log.txt'), 'utf-8')).toBe('typecheck\nintegration\n');
});

test('passes passWithNoTests to related-test runs', async () => {
  const repoPath = await repo();
  await writeFile(join(repoPath, 'test-runner.js'), "const fs=require('fs');if(process.argv.includes('--findRelatedTests')&&!process.argv.includes('--passWithNoTests'))process.exit(1);fs.appendFileSync('log.txt', process.argv.includes('--passWithNoTests') ? 'passWithNoTests\\n' : 'full\\n');", 'utf-8');
  await writeFile(join(repoPath, 'package.json'), JSON.stringify({ name: 'progressive', scripts: { typecheck: nodeScript('typecheck'), test: 'node test-runner.js' } }), 'utf-8');
  await writeVerify(repoPath);
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
  await writeVerify(repoPath);
  await writeFile(join(repoPath, 'src.ts'), '', 'utf-8');
  const result = await runVerify('PATH="./fakebin:$PATH" AGENTLOOP_SKIP_DEPCHECK=1 ./verify.sh --progressive --merge src.ts', repoPath);
  expect(result.ok && result.value.pass).toBe(true);
  await expect(access(join(repoPath, 'npx.log'))).rejects.toBeDefined();
});
