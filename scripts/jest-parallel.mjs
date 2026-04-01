import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const jestBin = join(root, 'node_modules', 'jest', 'bin', 'jest.js');
const userArgs = process.argv.slice(2);
const hasWorkerControl = userArgs.some(arg => arg === '--runInBand' || arg === '-i' || arg === '--maxWorkers' || arg.startsWith('--maxWorkers='));
const args = [
  '--experimental-vm-modules',
  jestBin,
  '--passWithNoTests',
  ...(!hasWorkerControl ? ['--maxWorkers=100%'] : []),
  ...userArgs,
];

const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
child.on('error', error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
