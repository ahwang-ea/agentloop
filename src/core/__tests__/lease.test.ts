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

test('waits for an in-flight renewal before returning success', async () => {
  const work = gate(), renew = gate();
  let settled = false;
  const promise = withLease(async () => { await work.wait; return ok('done'); }, async () => { await renew.wait; return ok(undefined); }, 5).then(result => { settled = true; return result; });
  await jest.advanceTimersByTimeAsync(6);
  work.release();
  await Promise.resolve();
  expect(settled).toBe(false);
  renew.release();
  await expect(promise).resolves.toEqual(ok('done'));
});

test('returns delayed renewal failures with details after work completes', async () => {
  const work = gate(), renew = gate(), details = { phase: 'renew' };
  const promise = withLease(async () => { await work.wait; return ok('done'); }, async () => { await renew.wait; return err('SESSION_ERROR', 'renew failed', details); }, 5);
  await jest.advanceTimersByTimeAsync(6);
  work.release();
  renew.release();
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
