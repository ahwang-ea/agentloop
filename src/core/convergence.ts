// core/convergence.ts — Tracks round-over-round errors, classifies progress.

import type { ConvergenceState, ConvergenceConfig, ConvergenceRound, VerifyResult } from '../types/index.js';

export function trackRound(state: ConvergenceState, verify: VerifyResult, tokensDelta: number): number {
  const round: ConvergenceRound = {
    round: state.rounds.length + 1,
    issueCount: verify.errors.length,
    issueHashes: verify.errors.map(e => e.hash),
    elapsed: verify.duration,
    tokens: tokensDelta,
  };
  state.rounds.push(round);
  return round.round;
}

export function classifyConvergence(
  state: ConvergenceState, config: ConvergenceConfig,
): ConvergenceState['classification'] {
  const { rounds } = state;
  if (rounds.length < 2) return 'unknown';

  // Stuck: identical full error set for N consecutive rounds
  const recent = rounds.slice(-config.stuckThreshold);
  if (recent.length >= config.stuckThreshold) {
    const refSet = new Set(recent[0].issueHashes);
    const allSame = refSet.size > 0 && recent.every(r => {
      if (r.issueHashes.length !== refSet.size) return false;
      return r.issueHashes.every(h => refSet.has(h));
    });
    if (allSame) return 'stuck';
  }

  // Thrashing: high hash overlap with 2-rounds-ago (oscillating)
  if (rounds.length >= 3) {
    const current = new Set(rounds[rounds.length - 1].issueHashes);
    const twoAgo = rounds[rounds.length - 3].issueHashes;
    const overlap = twoAgo.filter(h => current.has(h)).length;
    if (twoAgo.length > 0 && overlap / twoAgo.length >= config.thrashOverlapRatio) {
      return 'thrashing';
    }
  }

  // Converging: net unresolved issues must actually be falling over a rolling window
  const last = rounds[rounds.length - 1];
  const prev = rounds[rounds.length - 2];
  if (last.issueCount < prev.issueCount) return 'converging';

  // Same count with new hashes: only converging if resolved >= introduced
  if (last.issueCount === prev.issueCount) {
    const prevSet = new Set(prev.issueHashes);
    const lastSet = new Set(last.issueHashes);
    const resolved = prev.issueHashes.filter(h => !lastSet.has(h)).length;
    const introduced = last.issueHashes.filter(h => !prevSet.has(h)).length;
    if (resolved > 0 && resolved >= introduced) return 'converging';
  }

  // 3-round rolling window: converging only if net unresolved is falling
  if (rounds.length >= 3) {
    const threeAgo = rounds[rounds.length - 3];
    const threeAgoSet = new Set(threeAgo.issueHashes);
    const lastSet = new Set(last.issueHashes);
    const resolvedFromThreeAgo = threeAgo.issueHashes.filter(h => !lastSet.has(h)).length;
    const introducedSinceThreeAgo = last.issueHashes.filter(h => !threeAgoSet.has(h)).length;
    if (resolvedFromThreeAgo > introducedSinceThreeAgo) return 'converging';
  }

  return 'unknown';
}

/** Web search only when not converging: overlapping errors with non-decreasing count. */
export function shouldWebSearch(conv: ConvergenceState): boolean {
  if (conv.classification === 'converging') return false;
  const { rounds } = conv;
  if (rounds.length < 2) return false;
  const current = rounds[rounds.length - 1];
  const prev = rounds[rounds.length - 2];
  const currentSet = new Set(current.issueHashes);
  const overlap = prev.issueHashes.filter(h => currentSet.has(h));
  return overlap.length > 0 && current.issueCount >= prev.issueCount;
}
