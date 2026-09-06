// Generous per-game review thresholds, not proof of an honest run. Suspicious
// scores are kept for review instead of being silently capped or ranked.
const REVIEW_LIMITS = {
  stack: 5000000, flap: 10000, tower: 10000, dash: 1000000,
  invade: 100000000, invade_coop: 100000000, wio: 10000000, squad: 10000000
};
export function scoreReviewReason(game, score) {
  if (!Object.hasOwn(REVIEW_LIMITS, game)) return 'unknown-game';
  if (!Number.isSafeInteger(score) || score < 0) return 'invalid-score';
  return score > REVIEW_LIMITS[game] ? 'above-game-review-limit' : '';
}
