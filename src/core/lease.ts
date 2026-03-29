// core/lease.ts — Renew queue leases while long-running operations are in flight.

import { err, type Result } from '../shared/result.js';

export async function withLease<T>(
  run: () => Promise<Result<T>>,
  renew: () => Promise<Result<void>>,
  intervalMs = 30_000,
): Promise<Result<T>> {
  let leaseError: Result<never> | null = null;
  const timer = setInterval(() => {
    void renew()
      .then(r => { if (!r.ok && !leaseError) leaseError = err(r.error.code, r.error.message, r.error.details); })
      .catch(e => { if (!leaseError) leaseError = err('UNKNOWN', e instanceof Error ? e.message : 'Lease renewal threw'); });
  }, intervalMs);
  try {
    const result = await run();
    return leaseError ?? result;
  } catch (e) {
    return err('UNKNOWN', e instanceof Error ? e.message : 'Lease-wrapped operation threw');
  } finally {
    clearInterval(timer);
  }
}
