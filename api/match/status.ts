import { unpackAccount } from "@solana/spl-token";
import { enumKey, matchPda, type PlayerStatus } from "../../src/chain/escrow.js";
import { preflight, endpoint, mint, parseId, parsePubkey, program } from "../_lib.js";
import { dbSelect } from "../_db.js";
import { FREE_WEAPONS, ITEM_WEAPON } from "../../src/economy/prices.js";

/**
 * POST /api/match/status  { id }  →  { state, entry, pool, players: [{ wallet, status }] }
 *
 * The match as the chain holds it, for the room server: which wallets have
 * approved a stake (joined), which have paid (collected), which backed out
 * (dropped). The room trusts this over what a player tells it, which is
 * the point — a seat is staked when the chain says so.
 *
 * With `approved: wallet`, also `approvedHere`: whether that wallet's stake
 * for this match can still be taken (its token account still lets this
 * match take the entry). A seat's "joined" outlives an approval that a
 * later pool replaced; this does not (room.ts, release). Null when the
 * account cannot be read.
 *
 * POST /api/match/status  { owner }  →  { weapons: number[] | null }
 *
 * The weapons a wallet owns: the free ones and every weapon it has a
 * purchase record for (api/store/buy.ts). The room lets a player bring only
 * these (2026-09-30: a player could claim any gun). Null when the records
 * cannot be read, so the room can tell "owns none" from "could not ask".
 * Here rather than in a function of its own: the plan allows twelve.
 */
/** Devnet confirmations can crawl; a function cut off mid-transaction is the worst outcome. */
export const maxDuration = 60;

export const POST = endpoint(async (body) => {
  if (body.owner !== undefined) {
    const owner = parsePubkey(body.owner).toBase58();
    const rows = await dbSelect<{ item: string }>(`purchases?wallet=eq.${owner}&select=item`);
    if (!rows) return { weapons: null };
    const bought = rows.map((r) => ITEM_WEAPON[r.item]).filter((w): w is number => Number.isInteger(w));
    return { weapons: [...new Set([...FREE_WEAPONS, ...bought])].sort((a, b) => a - b) };
  }
  const id = parseId(body.id);
  const p = program();
  const matchKey = matchPda(id);
  const m = await p.account.match.fetch(matchKey);
  let approvedHere: boolean | null | undefined;
  if (body.approved !== undefined) {
    const who = parsePubkey(body.approved);
    const seat = m.players.find((pl) => pl.key.equals(who));
    approvedHere = false;
    if (seat) {
      try {
        // The account the program recorded at join (collect.ts reads the same).
        const info = await p.provider.connection.getAccountInfo(seat.tokenAccount, "confirmed");
        if (info) {
          const a = unpackAccount(seat.tokenAccount, info);
          approvedHere =
            a.owner.equals(who) && a.mint.equals(mint()) && !!a.delegate?.equals(matchKey) && a.delegatedAmount >= BigInt(m.entry.toString()) &&
            // and the entry still there: an approval whose money had been sent
            // on kept its seat and its pool open (security review, 2026-10-14).
            a.amount >= BigInt(m.entry.toString()) && !a.isFrozen;
        }
      } catch {
        approvedHere = null;
      }
    }
  }
  return {
    state: enumKey(m.state),
    entry: Number(m.entry),
    pool: Number(m.pool),
    // When the match started on chain: the room signs it into the ranking.
    collectedAt: Number(m.collectedAt),
    players: m.players.map((pl) => ({ wallet: pl.key.toBase58(), status: enumKey<PlayerStatus>(pl.status) })),
    ...(approvedHere !== undefined ? { approvedHere } : {}),
  };
}, { signed: true });

/** The Android app asks before it posts; see preflight in _lib. */
export const OPTIONS = preflight;
