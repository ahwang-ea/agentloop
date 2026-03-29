import { classifyConvergence, shouldWebSearch } from '../convergence.js';
import type { ConvergenceConfig, ConvergenceRound, ConvergenceState } from '../../types/index.js';

const makeRound = (round: number, issueHashes: string[]): ConvergenceRound => ({
  round,
  issueCount: issueHashes.length,
  issueHashes,
  elapsed: 1,
  tokens: 10,
});
const makeState = (hashes: string[][], classification: ConvergenceState['classification'] = 'unknown'): ConvergenceState => ({
  rounds: hashes.map((set, index) => makeRound(index + 1, set)),
  classification,
  webSearchTriggered: false,
});

describe('classifyConvergence', () => {
  let config: ConvergenceConfig;

  beforeEach(() => {
    config = { maxWallClock: 600, maxTokens: 10_000, stuckThreshold: 3, thrashOverlapRatio: 0.5 };
  });

  test('classifies decreasing issues and same-count hash replacement as converging', () => {
    expect(classifyConvergence(makeState([['a', 'b', 'c'], ['a', 'b']]), config)).toBe('converging');
    expect(classifyConvergence(makeState([['a', 'b'], ['a', 'c']]), config)).toBe('converging');
  });

  test('classifies identical errors across three rounds as stuck', () => {
    expect(classifyConvergence(makeState([['a', 'b'], ['a', 'b'], ['a', 'b']]), config)).toBe('stuck');
  });

  test('classifies oscillation against two-rounds-ago as thrashing', () => {
    expect(classifyConvergence(makeState([['a', 'b'], ['c', 'd'], ['a', 'b']]), config)).toBe('thrashing');
  });

  test('returns unknown when there are fewer than two rounds', () => {
    expect(classifyConvergence(makeState([['a']]), config)).toBe('unknown');
  });
});

describe('shouldWebSearch', () => {
  let conv: ConvergenceState;

  beforeEach(() => {
    conv = makeState([['a', 'b'], ['a', 'b', 'c']]);
  });

  test('returns true only for overlapping non-converging errors', () => {
    expect(shouldWebSearch(conv)).toBe(true);
    expect(shouldWebSearch({ ...conv, classification: 'converging' })).toBe(false);
    expect(shouldWebSearch(makeState([['a', 'b'], ['c', 'd']]))).toBe(false);
  });
});
