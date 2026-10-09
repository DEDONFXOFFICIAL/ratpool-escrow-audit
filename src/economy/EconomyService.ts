import type { MatchResult, PriceTier, RankedPlayer } from "@/state/types";
import { MAX_PLAYERS, PLATFORM_FEE } from "@/state/types";
import { placeShares } from "@/state/payout";

/**
 * The money layer, behind a single swappable interface.
 *
 * Fulfilled by ChainEconomy (the escrow on Solana) in the real game and by
 * MockEconomy in the demo. The surface was drawn to fit any of:
 *   - Circle Programmable Wallets (semi-custodial, USDC-native, covers gas)
 *   - Coinflow / Sphere payout rails
 *   - a forked, audited on-chain Anchor escrow program (non-custodial)
 *
 * Nothing in the UI or gameplay touches USDC transfer details directly — it
 * all goes through this interface, so the escrow decision never blocks the
 * game build and can change without touching screens.
 */
export interface EscrowReceipt {
  matchId: string;
  tier: PriceTier;
  held: number; // USDC moved into escrow for this player
  /**
   * How many rats staked into this pool.
   *
   * The pool is this many entry fees, so the number has to travel with the
   * receipt. The arena used to settle against however many fighters it happened
   * to spawn, which meant a lobby that needed ten players to form could pay out
   * a pool of eight. The roster that paid and the roster that plays must be the
   * same number, and this is where that number lives.
   */
  roster: number;
  /**
   * How many of those seats actually paid.
   *
   * Equal to `roster` in the mock, where every seat is a stake. On chain it
   * is the count the vault holds. The pool is `stakers` entries, and nothing
   * else is allowed to say otherwise.
   */
  stakers: number;
}

export interface EconomyService {
  getBalance(): Promise<number>;
  deposit(amount: number): Promise<number>; // returns new balance
  withdraw(amount: number): Promise<number>; // returns new balance

  /** Buy a store item outright. Debits the balance; nothing to refund later. */
  /** Pay for a store item; `itemId` makes it a recorded purchase (chain builds). Returns the new balance. */
  purchase(amount: number, memo: string, itemId?: string): Promise<number>;

  /**
   * Take a seat in a lobby for this tier. Nothing is debited.
   *
   * On chain this is the one wallet prompt a player sees: an approval that
   * lets the match collect one entry later, if the room fills. The mock has
   * nothing to approve and returns at once. A rejection here (the player
   * changed their mind at the prompt) is an error, and the lobby is not
   * entered.
   */
  enterLobby(tier: PriceTier): Promise<void>;

  /** Give the seat back. Free while the room is still filling. */
  leaveLobby(): Promise<void>;

  /**
   * The room server's way in: the room opened the on-chain match; this
   * approves one entry to it. The same approval enterLobby makes, for a
   * match somebody else opened. Chain build only.
   */
  stakeInto?(matchId: string, tier: PriceTier, admit?: { exp: number; sig: string } | null): Promise<void>;
  /** Revoke the pending or supplied match approval before collection. Chain build only. */
  unstake?(matchId?: string): Promise<void>;

  /**
   * Collect this player's stake into the match pool. Called only once a lobby
   * has actually reached its minimum size — never at the moment a tier is
   * picked — so backing out of a lobby that never filled costs nothing.
   */
  joinMatch(tier: PriceTier, roster: number): Promise<EscrowReceipt>;

  /** Automatic refund if a lobby stalls and the player exits (GDD §8). */
  refund(receipt: EscrowReceipt): Promise<number>; // returns new balance

  /**
   * Settle a finished match: deduct the platform's cut (PLATFORM_FEE), split the rest across
   * the paid ranks, credit the local player automatically (no manual claim).
   * Returns the fully-costed MatchResult for the results screen.
   *
   * The pool is computed from the RECEIPT, not from anything the match reports.
   * That used to take a player count handed over by the arena — which is to say
   * a number produced on the player's own machine, deciding how much money came
   * out of the pool. The receipt is the record of what was actually collected,
   * and it is the only thing here allowed to say how big the pot is.
   */
  settleMatch(
    receipt: EscrowReceipt,
    ranked: RankedPlayer[],
    opts?: SettleOptions,
  ): Promise<MatchResult>;
}

export interface SettleOptions {
  /**
   * Whether to actually pay the local player.
   *
   * False when the match failed the integrity audit. The board is still
   * produced — a player whose match is thrown out is owed the reason and the
   * scores it was thrown out over — but nothing is credited. Withholding the
   * skulls while paying the money out, which is what happened before, gets the
   * incentive exactly backwards: the money is what a cheat is played for.
   */
  credit?: boolean;
}

/**
 * Payout curve. The platform keeps its cut (PLATFORM_FEE); the rest — the *net* pool — is
 * split across the podium and nowhere else: 50 / 30 / 20 to the top three
 * (src/state/payout.ts). Fourth place and below earn nothing.
 */
export function payoutSplit(playerCount: number): number[] {
  return placeShares(playerCount);
}

export function computePayouts(
  entry: number,
  playerCount: number,
  ranked: RankedPlayer[],
): { pool: number; fee: number; ranked: RankedPlayer[] } {
  // Clamped to a real lobby. A pool cannot be smaller than the one player who
  // is definitely in it, and cannot be larger than a full room — so a roster
  // that arrives wrong, from a corrupted record or a tampered one, is a wrong
  // board rather than an invented pot.
  playerCount = Math.max(1, Math.min(MAX_PLAYERS, Math.floor(playerCount) || 1));
  const pool = entry * playerCount;
  const fee = pool * PLATFORM_FEE;
  const net = pool - fee;
  const split = payoutSplit(playerCount); // paid places only — see payoutSplit
  const withPay = ranked.map((p) => ({
    ...p,
    payout: p.rank <= split.length ? +(net * split[p.rank - 1]).toFixed(2) : 0,
  }));
  return { pool: +pool.toFixed(2), fee: +fee.toFixed(2), ranked: withPay };
}
