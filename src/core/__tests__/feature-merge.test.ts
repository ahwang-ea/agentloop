import { err, ok } from '../../shared/result.js';
import { mergeFeatureAtomically } from '../feature-merge.js';

test('merges feature atomically with docs refresh before commit', async () => {
  const calls: string[] = [];
  const git = {
    prepareMerge: async () => { calls.push('prepare'); return ok(undefined); },
    commitBase: async () => { calls.push('commit'); return ok('abc'); },
    abortMerge: async () => { calls.push('abort'); return ok(undefined); },
  };
  const refresh = async () => { calls.push('refresh'); return ok(undefined); };
  const result = await mergeFeatureAtomically(git as never, 'al/feature-x', 'main', 'merge: x', refresh);
  expect(result.ok ? result.value : 'bad').toBe('abc');
  expect(calls).toEqual(['prepare', 'refresh', 'commit']);
});

test('aborts prepared merge when docs refresh fails', async () => {
  const calls: string[] = [];
  const git = {
    prepareMerge: async () => { calls.push('prepare'); return ok(undefined); },
    commitBase: async () => { calls.push('commit'); return ok('abc'); },
    abortMerge: async () => { calls.push('abort'); return ok(undefined); },
  };
  const result = await mergeFeatureAtomically(git as never, 'al/feature-x', 'main', 'merge: x', async () => err('VERIFY_FAILED', 'docs failed'));
  expect(result.ok).toBe(false);
  expect(calls).toEqual(['prepare', 'abort']);
});
