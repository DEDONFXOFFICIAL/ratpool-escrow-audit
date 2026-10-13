import { enumKey, matchPda, toBn } from "../../src/chain/escrow.js";
import { RECOVERY_FLOOR_LAMPORTS, requireFeeFunds, preflight, authority, endpoint, parseId, parsePubkey, program } from "../_lib.js";
import { closeFinished, refundAll, sweepOwed } from "../_refund.js";
import { dbSelect, dbUpdate } from "../_db.js";

/**
 * POST /api/match/abandon  { id, evict? }  →  { ok, state, heldUntil?, evicted? }
 * POST /api/match/abandon  { sweep: true }  →  { ok, matches, refunded, owed }
 *
 * The player walked out of a room, or a room was never played. Nothing here
 * takes the client's word for anything: the chain says what state the match
 * is in, and the only things this can do are cancel an open room, return
 * whatever a cancelled room still holds, and reclaim rent from an empty one.
 *
 * The room server's call alone. Unsigned, anyone could cancel any lobby that
 * was still filling, one request each (2026-09-29).
 *
 * The sweep is the room server's schedule (every ten minutes): every match
 * on chain still holding stakes past the point it can pay them out gives
 * them back, whatever became of its room (api/_refund.ts, sweepOwed).
 */
/** Devnet confirmations can crawl; a function cut off mid-transaction is the worst outcome. */
export const maxDuration = 60;

export const POST = endpoint(async (body) => {
  if (body.sweep === true) {
    // The database is asked something every run, first: the free plan pauses
    // a project after a quiet week, and a paused database stops the game
    // until it is woken by hand (owner, 2026-10-08). The sweep's log shows it.
    const awake = (await dbSelect<{ id: string }>("matches?select=id&limit=1")) !== null;
    const p = program();
    const auth = authority().publicKey;
    await requireFeeFunds(p.provider.connection, auth, RECOVERY_FLOOR_LAMPORTS);
    // No new transaction after 20 s: one sent then has the rest of the
    // function's 60 s to confirm.
    return { ok: true, awake, ...(await sweepOwed(p, auth, Date.now() + 20_000)) };
  }
  const id = parseId(body.id);
  const p = program();
  const auth = authority().publicKey;
  await requireFeeFunds(p.provider.connection, auth, RECOVERY_FLOOR_LAMPORTS);
  const key = matchPda(id);

  const info = await p.provider.connection.getAccountInfo(key);
  if (!info) return { ok: true, state: "closed" };

  let m = await p.account.match.fetch(key);
  let state = enumKey(m.state);

  // Seats the room no longer has: a wallet that took its ticket and left,
  // or whose leave never landed, gives its on-chain seat back (escrow v2
  // evict; review 2026-10-06, tickets outliving their seat).
  if (Array.isArray(body.evict)) {
    if (state !== "open") return { ok: true, state, evicted: 0 };
    const gone = new Set(body.evict.map((w) => parsePubkey(w).toBase58()));
    let evicted = 0;
    for (const pl of m.players) {
      if (!gone.has(pl.key.toBase58()) || enumKey(pl.status) !== "joined") continue;
      await p.methods.evict(toBn(id), pl.key).accountsPartial({ authority: auth }).rpc();
      evicted++;
    }
    return { ok: true, state, evicted };
  }

  if (state === "open") {
    await p.methods.cancel(toBn(id)).accountsPartial({ authority: auth }).rpc();
    m = await p.account.match.fetch(key);
    state = "cancelled";
    await dbUpdate("matches", { id: id.toString() }, { state });
  }

  // A collected match that never played is held by the program until its
  // refund deadline (it cannot be cancelled once collected). The room keeps
  // its job and comes back then, instead of forgetting the stakes.
  const refundAfter = Number(m.refundAfter);
  const expired = refundAfter !== 0 && Date.now() / 1000 >= refundAfter;
  if (state === "collected" && !expired) return { ok: true, state, heldUntil: refundAfter };

  // Past the deadline, or cancelled: every stake goes back now, without
  // waiting for anyone to claim it, the platform paying the fees.
  if (state === "cancelled" || state === "collected") {
    await refundAll(p, id, m, auth);
    m = await p.account.match.fetch(key);
  }

  await closeFinished(p, id, m, auth);
  // A settled room keeps its record; a room that never played is closed.
  if (state !== "settled") await dbUpdate("matches", { id: id.toString() }, { state: state === "collected" ? "refunded" : "closed" });
  return { ok: true, state: "closed" };
}, { signed: true });

/** The Android app asks before it posts; see preflight in _lib. */
export const OPTIONS = preflight;
