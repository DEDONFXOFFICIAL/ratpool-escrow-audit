import type { PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getMinimumBalanceForRentExemptAccount } from "@solana/spl-token";
import bs58 from "bs58";
import { collectedPlayers, enumKey, IDL, PROGRAM_ID, toBn, TOKEN_PROGRAM_ID, type EscrowProgram, type MatchAccount } from "../src/chain/escrow.js";
import { ata, mint, onlySol, requireFeeFunds } from "./_lib.js";
import { dbUpdate, withinLimit, withinSharedLimit } from "./_db.js";

/**
 * Every collected stake in a match back to its player.
 *
 * The player's token account is recreated first if they closed it after
 * the stake was taken: without it the refund fails, and one closed account
 * used to stop every refund after it (review 2026-10-06). The program pays
 * each stake once; a retry only repeats what is still owed.
 */
export async function refundAll(p: EscrowProgram, id: bigint, m: MatchAccount, payer: PublicKey, until = Infinity): Promise<void> {
  // Each player on their own: one account that cannot take its refund (its
  // owner changed, say) must not hold up everyone after it. What failed is
  // reported, so the caller's retry comes back for exactly that. Past
  // `until`, the rest is left for that retry rather than cut off mid-call.
  const failed: string[] = [];
  for (const k of collectedPlayers(m)) {
    if (Date.now() > until) {
      failed.push(k.toBase58());
      continue;
    }
    try {
      // The player's usual account and no other (escrow v4): reopened, the
      // platform paying, if it was closed; only with the usual floor and the
      // fee left over after its rent (security review, 2026-10-14; outside
      // review the same day: the recovery floor alone let repeated reopening
      // take the platform below what everything else needs).
      const conn = p.provider.connection;
      const usual = ata(k);
      const info = await conn.getAccountInfo(usual, "confirmed");
      // Made only when missing: the make-if-missing step refuses an existing
      // account its owner handed to someone else, and that refund would never
      // land (review of escrow v4).
      const missing = !info || onlySol(info);
      if (missing) {
        const rent = await getMinimumBalanceForRentExemptAccount(conn);
        await requireFeeFunds(conn, payer, 10_000_000 + rent + 20_000);
        // Only a player who closed their own account with outside tools needs
        // one made, and closing it again after each refund took the rent from
        // the platform every time: twice a day per wallet, twenty a day in
        // all (outside review, 2026-10-14). Past that the refund waits for a
        // later sweep; the stake stays theirs in the vault meanwhile.
        if (!(await withinLimit(`refund:make:${k.toBase58()}`, 2, 86400)) || !(await withinSharedLimit("refund:make:all", 20, 86400))) {
          throw new Error("accounts made for refunds are at today's limit");
        }
      }
      await p.methods
        .claimRefund(toBn(id), k)
        .accountsPartial({ mint: mint(), playerAta: usual, tokenProgram: TOKEN_PROGRAM_ID })
        .preInstructions(missing ? [createAssociatedTokenAccountIdempotentInstruction(payer, usual, k, mint(), TOKEN_PROGRAM_ID)] : [])
        .rpc();
    } catch (e) {
      failed.push(k.toBase58());
      console.error("[refund] not refunded yet", { id: id.toString(), player: k.toBase58(), error: (e as Error).message });
    }
  }
  if (failed.length) throw new Error(`${failed.length} refund(s) still owed`);
}

/**
 * Close a finished match: rent back to the authority, any stray deposit
 * swept to the fee wallet the match was created with (escrow v2). The
 * program refuses while anything is still owed, which is the point.
 */
export async function closeFinished(p: EscrowProgram, id: bigint, m: MatchAccount, authority: PublicKey): Promise<string> {
  return p.methods
    .closeMatch(toBn(id))
    .accountsPartial({ authority, mint: mint(), feeAta: ata(m.feeWallet), tokenProgram: TOKEN_PROGRAM_ID })
    .preInstructions([createAssociatedTokenAccountIdempotentInstruction(authority, ata(m.feeWallet), m.feeWallet, mint(), TOKEN_PROGRAM_ID)])
    .rpc();
}

const MATCH_DISCRIMINATOR = bs58.encode(
  Uint8Array.from((IDL as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((a) => a.name === "Match")!.discriminator),
);

/** Longer than a collect call can run (maxDuration 60). */
const GRACE_S = 120;
/**
 * An open match nothing was ever collected into, this old, has no room
 * left filling it (a room's minute starts again only while someone waits
 * in it). Its id is its creation time in ms x 1000 (newMatchId).
 */
const STALE_OPEN_MS = 48 * 3600_000;

export interface SweepResult {
  /** Matches on chain. */
  matches: number;
  /** Matches whose every stake went back this time, and were closed. */
  refunded: number;
  /** Matches with stakes still owed, for the next sweep. */
  owed: number;
}

/**
 * The net under every other refund (review 2026-10-06, R18): any match on
 * chain still holding stakes it can no longer pay out, because its refund
 * deadline passed or it was cancelled, gets them back to their players and
 * is closed, whatever became of the room that should have done it. A room
 * restarted mid-job, a payout that hit a dead end, a refund that failed
 * once: all end here within one sweep of the deadline.
 *
 * Read from the chain, so nothing is missed for want of a record; a match
 * that cannot be read as one is skipped, never guessed at. Stops starting
 * work at `until`; what is left is counted and the next sweep finishes it.
 */
export async function sweepOwed(p: EscrowProgram, payer: PublicKey, until: number): Promise<SweepResult> {
  const conn = p.provider.connection;
  const accounts = [...await conn.getProgramAccounts(PROGRAM_ID, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: MATCH_DISCRIMINATOR } }],
  })];
  const out: SweepResult = { matches: accounts.length, refunded: 0, owed: 0 };
  const now = Date.now() / 1000;
  // A different order every sweep: a match whose refunds keep failing must
  // not take the whole budget, sweep after sweep, from the ones behind it.
  for (let i = accounts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [accounts[i], accounts[j]] = [accounts[j], accounts[i]];
  }
  for (const { pubkey, account } of accounts) {
    let m: MatchAccount;
    try {
      m = p.coder.accounts.decode("match", account.data);
    } catch {
      continue;
    }
    const state = enumKey<string>(m.state);
    const owed = collectedPlayers(m).length;
    const refundAfter = Number(m.refundAfter);
    const expired = refundAfter !== 0 && now >= refundAfter;
    // Before its deadline a collected match is still the room's to pay out.
    // An open one past it holds stakes from a collection cut off before the
    // start; the program refunds those too, and the last refund cancels it.
    // An open match whose opening reply was lost: the room never heard its
    // id and closed without asking for it to be closed, and with nothing
    // ever collected it has no deadline, so it held its rent for good
    // (review, 2026-10-12). Cancelled, then closed like the rest, once
    // nothing has been collected into it.
    const createdMs = Number(BigInt(m.id.toString()) / 1000n);
    // Joined players too (security review, 2026-10-14): a join only approves,
    // nothing of theirs is in the vault, and approvals whose money was sent
    // on could hold a pool open for good. Two days is far past any fill.
    const staleOpen = state === "open" && refundAfter === 0 && owed === 0 && Date.now() - createdMs > STALE_OPEN_MS;
    const due = state === "cancelled" || (state === "collected" && expired) || (state === "open" && expired && owed > 0) || staleOpen;
    if (!due) continue;
    // A short pool is cancelled and refunded in the one call that collected
    // it (api/match/collect.ts); one whose first stake was taken moments ago
    // is left to finish that itself.
    if (state === "cancelled" && owed && now - (refundAfter - Number(m.refundDelay)) < GRACE_S) continue;
    if (Date.now() > until) {
      if (owed) out.owed++;
      continue;
    }
    const id = BigInt(m.id.toString());
    if (owed) {
      try {
        await refundAll(p, id, m, payer, until);
      } catch (e) {
        out.owed++;
        console.error("[sweep] still owed", { id: id.toString(), error: (e as Error).message });
        continue;
      }
      out.refunded++;
      console.log("[sweep] every stake returned", { id: id.toString(), stakes: owed });
      await dbUpdate("matches", { id: id.toString() }, { state: "refunded" });
    }
    // Nothing is owed now; the close only reclaims rent, and can wait a sweep.
    if (Date.now() > until) continue;
    try {
      if (staleOpen) await p.methods.cancel(toBn(id)).accountsPartial({ authority: payer }).rpc();
      await closeFinished(p, id, await p.account.match.fetch(pubkey), payer);
      if (!owed) await dbUpdate("matches", { id: id.toString() }, { state: "closed" });
    } catch (e) {
      console.error("[sweep] not closed yet", { id: id.toString(), error: (e as Error).message });
    }
  }
  return out;
}
