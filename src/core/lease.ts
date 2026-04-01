// core/lease.ts — Renew queue leases while long-running operations are in flight.

import { err, type Result } from '../shared/result.js';

const renewalDetails = (details?: Record<string, unknown>) => ({ ...(details ?? {}), leaseRenewal: true });
const renewalError = (code: string, message: string, details?: Record<string, unknown>) => err(code as never, message, renewalDetails(details));

export async function withLease<T>(
  run: () => Promise<Result<T>>,
  renew: () => Promise<Result<void>>,
  intervalMs = 30_000,
): Promise<Result<T>> {
  let leaseError: Result<never> | null = null;
  let inFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inFlight || leaseError) return;
    inFlight = renew()
      .then(r => { if (!r.ok && !leaseError) leaseError = renewalError(r.error.code, r.error.message, r.error.details); })
      .catch(e => { if (!leaseError) leaseError = renewalError('UNKNOWN', e instanceof Error ? e.message : 'Lease renewal threw'); })
      .finally(() => { inFlight = null; });
  }, intervalMs);
  const drain = async () => { clearInterval(timer); if (inFlight) await inFlight; };
  try {
    const result = await run();
    await drain();
    return leaseError ?? result;
  } catch (e) {
    await drain();
    return leaseError ?? err('UNKNOWN', e instanceof Error ? e.message : 'Lease-wrapped operation threw');
  }
}
