// Default escrow-v6 policy: seven winners share the 90% net pot.
// Relative weights 10/9/8/6/5/4/3 give gross-pot percentages
// 20/18/16/12/10/8/6 with a 10% platform fee.

export const PAYOUT_WEIGHTS = [10, 9, 8, 6, 5, 4, 3];
export const PODIUM_PERCENT = PAYOUT_WEIGHTS;

/** How many finishers are paid when `stakers` rats staked: the top seven. */
export function paidPlaces(stakers: number): number {
  return Math.max(1, Math.min(PODIUM_PERCENT.length, stakers));
}

/** Each paid place's fraction of the net pool (after the platform's cut), best first. */
export function placeShares(stakers: number): number[] {
  const shares = PODIUM_PERCENT.slice(0, paidPlaces(stakers));
  const total = shares.reduce((a, b) => a + b, 0);
  return shares.map((s) => s / total);
}
