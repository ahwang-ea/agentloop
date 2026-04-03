import type { BenchmarkSuite } from '../types.js';
import { polymarketGoldenTest } from '../golden-tests/polymarket.js';

export const polymarketSuite: BenchmarkSuite = {
  name: 'Polymarket/Kalshi arbitrage finder',
  goal: [
    'Build a TypeScript CLI tool that fetches Polymarket and Kalshi markets,',
    'matches markets by topic similarity, calculates price discrepancies where',
    'buying YES on one platform and NO on the other guarantees profit after fees,',
    'and displays opportunities sorted by profit margin. Include adapter interfaces',
    'for both APIs, mock data for tests, and a terminal table output.',
  ].join(' '),
  maxTimeSec: 2400,
  baseDeps: ['axios@1.14.0', 'cli-table3'],
  goldenTestFile: polymarketGoldenTest,
  acceptanceTests: [
    { type: 'command', name: 'compiles', cmd: 'npm', args: ['run', 'typecheck'] },
    { type: 'command', name: 'tests pass', cmd: 'npm', args: ['test'] },
    { type: 'file-contains-regex', name: 'has adapter interfaces', dir: 'src', extensions: ['.ts'], regex: 'interface\\s+\\w+Adapter' },
    { type: 'min-file-count', name: 'has 3+ test files', dir: 'src', extension: '.test.ts', min: 3 },
  ],
};
