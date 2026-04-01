import { jest } from '@jest/globals';
import { err, ok } from '../../shared/result.js';
import { withLease } from '../lease.js';

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

const gate = () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = () => resolve(); });
  return { wait, release };
};

test('returns the wrapped result when renewals succeed', async () => {
  const pending = gate(), renew = jest.fn(async () => ok(undefined));
  const promise = withLease(async () => { await pending.wait; return ok('done'); }, renew, 5);
  await jest.advanceTimersByTimeAsync(6);
  expect(renew).toHaveBeenCalledTimes(1);
  pending.release();
  const result = await promise;
  expect(result).toEqual(ok('done'));
});

test('returns renewal failures with details once the wrapped work completes', async () => {
  const pending = gate(), details = { phase: 'renew' };
  const promise = withLease(async () => { await pending.wait; return ok('done'); }, async () => err('SESSION_ERROR', 'renew failed', details), 5);
  await jest.advanceTimersByTimeAsync(6);
  pending.release();
  const result = await promise;
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'SESSION_ERROR', message: 'renew failed', details: expect.objectContaining({ ...details, leaseRenewal: true }) }) });
});

test('converts thrown renewal errors into UNKNOWN results', async () => {
  const pending = gate();
  const promise = withLease(async () => { await pending.wait; return ok('done'); }, async () => { throw new Error('renew boom'); }, 5);
  await jest.advanceTimersByTimeAsync(6);
  pending.release();
  const result = await promise;
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'UNKNOWN', message: 'renew boom', details: expect.objectContaining({ leaseRenewal: true }) }) });
});
