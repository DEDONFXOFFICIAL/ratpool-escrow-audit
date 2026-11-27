// Placement points shared by the client and settlement recorder.
// Version 1 remains available for historical results and pending claims.

/** What each finishing position is worth. Index 0 is first place. */
export const SKULLS_BY_RANK = [100, 90, 80, 60, 50, 40, 30];
export const FREE_PLAY_SKULLS_BY_RANK = [50, 45, 40, 30, 25, 20, 15];
export const LEGACY_SKULLS_BY_RANK = [50, 30, 20];

/** What everyone below the podium takes home. Never zero — that is the point. */
export const SKULLS_CONSOLATION = 10;

/** Pool prices and rewards move together; unknown/legacy prices keep base awards. */
export const POOL_SKULL_MULTIPLIERS = [
  { entry: 1, multiplier: 1 },
  { entry: 10, multiplier: 2 },
  { entry: 20, multiplier: 3 },
  { entry: 50, multiplier: 4 },
] as const;

export const poolSkullMultiplier = (entry: number): number =>
  POOL_SKULL_MULTIPLIERS.find((p) => p.entry === entry)?.multiplier ?? 1;

export const skullsForRank = (rank: number, entry = 0, version = 2): number =>
  Number.isInteger(rank) && rank > 0
    ? version === 1
      ? (LEGACY_SKULLS_BY_RANK[rank - 1] ?? SKULLS_CONSOLATION) * poolSkullMultiplier(entry)
      : rank <= SKULLS_BY_RANK.length ? SKULLS_BY_RANK[rank - 1] * poolSkullMultiplier(entry) : SKULLS_CONSOLATION
    : 0;

export const freePlaySkullsForRank = (rank: number, version = 2): number =>
  Number.isInteger(rank) && rank > 0
    ? (version === 1 ? LEGACY_SKULLS_BY_RANK : FREE_PLAY_SKULLS_BY_RANK)[rank - 1] ?? SKULLS_CONSOLATION : 0;
