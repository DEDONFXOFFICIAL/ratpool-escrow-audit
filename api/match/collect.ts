import { ComputeBudgetProgram } from "@solana/web3.js";
import { unpackAccount } from "@solana/spl-token";
import { collectedPlayers, enumKey, matchPda, toBn, TOKEN_PROGRAM_ID, type PlayerStatus } from "../../src/chain/escrow.js";
import { requireFeeFunds, preflight, authority, endpoint, HttpError, mint, parseId, parsePubkey, program } from "../_lib.js";
import { dbUpdate, usdc } from "../_db.js";
import { closeFinished, refundAll } from "../_refund.js";

/** Player token accounts per collect transaction — well under the size limit. */
const BATCH = 10; // the size-built program (program/Cargo.toml) spends a little more compute per transfer

/**
 * POST /api/match/collect  { id, wallets?, min? }
 *   →  { started, collected, dropped, pool, reason?, moved?, short? }
 *
 * The room is full: pull the approved stakes of the wallets seated in it
 * into the vault, then lock the match.
 *
 * Nothing moves unless enough of them can pay (owner: no money leaves a
 * wallet while the room is short). Every seated approval is checked first,
 * balance and allowance both, and with fewer payable than the minimum the
 * answer is TooFewPlayers with `moved: false` and the wallets that could not
 * pay, so the room drops those seats and keeps filling. Only the room's own
 * seats are collected: a player who left keeps an approval on chain that
 * nobody spends. If a stake still fails between the check and the transfer
 * and the count falls short, the match is cancelled and whatever was
 * collected is refunded on the spot, as before.
 */
/** Devnet confirmations can crawl; a function cut off mid-transaction is the worst outcome. */
export const maxDuration = 60;

export const POST = endpoint(async (body) => {
  const id = parseId(body.id);
  const p = program();
  const auth = authority().publicKey;
  const matchKey = matchPda(id);
  // Asked together: the players are waiting on the lock (owner, 2026-10-18:
  // "it's supposed to be as instant as" the payout).
  const [, first] = await Promise.all([requireFeeFunds(p.provider.connection, auth), p.account.match.fetch(matchKey)]);
  let m = first;
  if (enumKey(m.state) !== "open") throw new HttpError(409, "match is not open");
  // The room's minimum (six for a pool) when it names one, never below the
  // one the match was created with (pinned on chain, escrow v2).
  const asked = typeof body.min === "number" && Number.isInteger(body.min) && body.min > 0 && body.min <= 50 ? body.min : 0;
  const minimum = Math.max(m.minPlayers, asked);

  // Each seat with the token account it approved from, as the program
  // recorded it at join: collection reads and moves exactly that account.
  let joined = m.players
    .filter((pl) => enumKey<PlayerStatus>(pl.status) === "joined")
    .map((pl) => ({ key: pl.key, account: pl.tokenAccount }));
  if (Array.isArray(body.wallets)) {
    const seated = new Set(body.wallets.map((w) => parsePubkey(w).toBase58()));
    joined = joined.filter((j) => seated.has(j.key.toBase58()));
  }

  const entry = BigInt(m.entry.toString());
  const canPay = async () => {
  const infos = joined.length ? await p.provider.connection.getMultipleAccountsInfo(joined.map((j) => j.account), "confirmed") : [];
  return joined.filter(({ key: k, account }, i) => {
    const info = infos[i];
    if (!info) return false;
    try {
      const a = unpackAccount(account, info);
      // Still this player's account, of this mint, usable: an account whose
      // owner was changed after joining made the program refuse the whole
      // batch it sat in, honest stakes included (review 2026-10-06, C03).
      return (
        a.owner.equals(k) &&
        a.mint.equals(mint()) &&
        a.isInitialized &&
        !a.isFrozen &&
        a.amount >= entry &&
        !!a.delegate?.equals(matchKey) &&
        a.delegatedAmount >= entry
      );
    } catch {
      return false;
    }
  });
  };
  const payable = await canPay();
  // Every seat the room named that cannot pay, approval gone included.
  const named = Array.isArray(body.wallets) ? body.wallets.map((w) => parsePubkey(w).toBase58()) : joined.map((j) => j.key.toBase58());
  const shortOf = (can: typeof payable) => {
    const ok = new Set(can.map((j) => j.key.toBase58()));
    return named.filter((w) => !ok.has(w));
  };
  // Stakes an earlier run already moved (it was cut off between batches)
  // count towards the minimum. Only when nothing has moved at all may the
  // room be told so; otherwise the shortfall is cancelled and refunded below.
  const already = collectedPlayers(m).length;
  if (already === 0 && payable.length < minimum) {
    return {
      started: false,
      collected: 0,
      dropped: 0,
      pool: 0,
      reason: "TooFewPlayers",
      moved: false,
      short: shortOf(payable),
    };
  }

  // Everyone in one batch with nothing taken before: the start rides in the
  // same transaction as the collection, after it, so the minimum check
  // (min_after) guards both and one confirmation does the work of two.
  let startedWith = false;
  for (let i = 0; already + payable.length >= minimum && i < payable.length; i += BATCH) {
    const batch = payable.slice(i, i + BATCH);
    // The last batch asks the program for the room's minimum once it is
    // done, or nothing in it moves (escrow v4; earlier versions ignore it). A
    // player withdrawing between the check above and this used to leave the
    // pool short and the match cancelled (security review, 2026-10-14).
    const last = i + BATCH >= payable.length;
    const withStart = last && i === 0 && already === 0;
    try {
      await p.methods
        .collect(toBn(id), last ? Math.min(minimum, 255) : 0)
        .accountsPartial({ mint: mint(), authority: auth, tokenProgram: TOKEN_PROGRAM_ID })
        .remainingAccounts(batch.map((j) => ({ pubkey: j.account, isSigner: false, isWritable: true })))
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .postInstructions(withStart ? [await p.methods.start(toBn(id)).accountsPartial({ authority: auth }).instruction()] : [])
        .rpc();
      if (withStart) startedWith = true;
    } catch (e) {
      if (!last || !/TooFewPlayers/.test(String((e as Error)?.message ?? e) + JSON.stringify((e as { logs?: unknown })?.logs ?? ""))) throw e;
      // Nothing of this batch moved. With nothing moved before it either, the
      // room is told who cannot pay now and fills the pool again; otherwise
      // the shortfall is cancelled and refunded below, as before.
      if (already === 0 && i === 0) {
        return {
          started: false,
          collected: 0,
          dropped: 0,
          pool: 0,
          reason: "TooFewPlayers",
          moved: false,
          short: shortOf(await canPay()),
        };
      }
    }
  }

  m = await p.account.match.fetch(matchKey);
  const stakers = collectedPlayers(m);
  const dropped = m.players.filter((pl) => enumKey<PlayerStatus>(pl.status) === "dropped").length;

  if (stakers.length < minimum) {
    await p.methods.cancel(toBn(id)).accountsPartial({ authority: auth }).rpc();
    m = await p.account.match.fetch(matchKey);
    // A refund that cannot land yet (an account made for it over the day's
    // count, say) is the sweep's to finish: the room is still told the match
    // was cancelled, not a failure it would ask about again (outside review,
    // 2026-10-14).
    let refunded = true;
    try {
      await refundAll(p, id, m, auth);
    } catch (e) {
      refunded = false;
      console.error("[collect] refunds left to the sweep", { id: id.toString(), error: (e as Error).message });
    }
    if (refunded) await closeFinished(p, id, await p.account.match.fetch(matchKey), auth).catch(() => {});
    await dbUpdate("matches", { id: id.toString() }, { state: "cancelled", stakers: stakers.length });
    return {
      started: false,
      collected: stakers.length,
      dropped,
      pool: 0,
      reason: "TooFewPlayers",
    };
  }

  if (!startedWith) {
    await p.methods.start(toBn(id)).accountsPartial({ authority: auth }).rpc();
    m = await p.account.match.fetch(matchKey);
  }
  await dbUpdate(
    "matches",
    { id: id.toString() },
    { state: "collected", stakers: stakers.length, pool: usdc(m.pool.toString()) },
  );
  return {
    started: true,
    collected: stakers.length,
    dropped,
    pool: Number(m.pool),
    // Who paid and when the match started, as the chain has them: the room
    // goes straight to its countdown instead of asking again.
    players: m.players.map((pl) => ({ wallet: pl.key.toBase58(), status: enumKey<string>(pl.status) })),
    collectedAt: Number(m.collectedAt),
  };
}, { signed: true });

/** The Android app asks before it posts; see preflight in _lib. */
export const OPTIONS = preflight;
