import { PublicKey } from "@solana/web3.js";
import { BorshCoder, EventParser, type Idl } from "@anchor-lang/core";
import IDL_V3 from "../../src/chain/idl/ratpool_escrow.v3.idl.js";
import { collectedPlayers, enumKey, guardPda, matchPda, ownedByEscrow, referralPda, toBn, TOKEN_PROGRAM_ID, type EscrowProgram } from "../../src/chain/escrow.js";
import { requireFeeFunds, preflight, ata, authority, endpoint, entryUnits, HttpError, mint, parseId, parsePubkey, program } from "../_lib.js";
import { PRICE_TIERS } from "../../src/state/types.js";
import { DB_ENABLED, dbUpdate, dbUpsert, usdc } from "../_db.js";
import { closeFinished, refundAll } from "../_refund.js";
import { paySigned, type Payout } from "../_settle.js";
import { skullsForRank } from "../../src/state/skulls.js";
import { COUNTDOWN_SECONDS, matchSecondsFor } from "../../src/arena/shared.js";

/**
 * How much earlier than the clock allows a payout may still come: the chain's
 * clock and ours can disagree by a little. A ranking any earlier than the
 * match could have been played is not a result (review 2026-10-07, T02).
 */
const CLOCK_SLACK_S = 90;

/**
 * POST /api/match/settle  { id, ranking: string[], signed }
 *   →  { pool, fee, amounts, referrals, signature, recorded, recovered? }
 *
 * `ranking` is the finishing order of wallets, for the record; `signed` is
 * the same order signed by the room server for the escrow (server/src/api.ts
 * signSettlement). The program pays the first three stakers of the signed
 * order, every invited winner's recorded referrer and the fee wallet in one
 * instruction (api/_settle.ts), and the amounts returned here are computed
 * the way the program computes them, so the board the client draws is what
 * actually moved.
 *
 * Safe to call again, and the room server does until it gets an answer
 * (server/src/room.ts, pay()): a match the chain has already paid is
 * answered with the payout that happened, read from the settlement's own
 * receipt on chain, never paid twice. `recorded: false` means the payout
 * landed but the database did not take the record; calling again writes it.
 */
/** Devnet confirmations can crawl; a function cut off mid-transaction is the worst outcome. */
export const maxDuration = 60;

export const POST = endpoint(async (body) => {
  const id = parseId(body.id);
  if (!Array.isArray(body.ranking)) throw new HttpError(400, "ranking must be a list");
  const ranking = (body.ranking as unknown[]).map(parsePubkey);

  const p = program();
  const m = await p.account.match.fetchNullable(matchPda(id));
  const state = m ? enumKey(m.state) : "closed";

  // Paid already, by an earlier call whose answer never arrived (or paid and
  // closed since): the chain's receipt says who got what.
  if (state === "settled" || state === "closed") {
    // The room sends the payout it already saw: read directly, it cannot be
    // buried under transactions others sent to the match's account.
    const hint = typeof body.paidSig === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(body.paidSig) ? body.paidSig : undefined;
    const done = await findSettlement(p, id, hint);
    if (!done) {
      if (state === "closed") throw new HttpError(410, "match was closed without a payout");
      throw new HttpError(503, "match is paid; its receipt cannot be read yet");
    }
    const wallets = ranking.map((w) => w.toBase58());
    // A closed match no longer lists its stakers; in a pool room everyone
    // ranked was collected, and the receipt names the podium. A settled one
    // still does, but its podium now reads Paid, not Collected: counted only
    // as Collected, the winners fell out of the record (security audit R17).
    const stakers = m
      ? m.players
          .filter((pl) => ["collected", "paid"].includes(enumKey<string>(pl.status)))
          .map((pl) => pl.key.toBase58())
      : [...new Set([...done.winners, ...wallets])];
    const out = await record(id, stakers, wallets, done, m ? BigInt(m.entry.toString()) : undefined);
    if (m && out.recorded) await sendClose(p, id, m.feeWallet);
    return { ...out, recovered: true };
  }
  if (state !== "collected") {
    throw new HttpError(410, state === "cancelled" ? "match was cancelled; its stakes are refundable" : "match was never collected");
  }

  const auth = authority().publicKey;
  await requireFeeFunds(p.provider.connection, auth);
  // Past the refund deadline the program refuses a payout (escrow v2, C01):
  // the stakes go back instead, all of them, and the room stops asking.
  if (Number(m!.refundAfter) !== 0 && Date.now() / 1000 >= Number(m!.refundAfter)) {
    await refundAll(p, id, m!, auth);
    const after = await p.account.match.fetch(matchPda(id));
    await closeFinished(p, id, after, auth).catch(() => {});
    await dbUpdate("matches", { id: id.toString() }, { state: "refunded" });
    throw new HttpError(410, "the refund deadline passed; every stake was returned");
  }
  // The match must have been played. The program stamps when it started
  // (collectedAt); a pool runs its tier's full clock after a countdown, and
  // nothing ends one early. A ranking before then is refused, and the room
  // asks again later (a 409 is retried), so a slow clock costs nothing.
  const tier = PRICE_TIERS.find((t) => entryUnits(t) === BigInt(m!.entry.toString()));
  const override = Number(process.env.MATCH_SECONDS_OVERRIDE);
  const playSeconds = Number.isFinite(override) && override > 0 ? override : matchSecondsFor(tier?.id);
  const playedFrom = Number(m!.collectedAt);
  const earliest = playedFrom + COUNTDOWN_SECONDS + playSeconds - CLOCK_SLACK_S;
  if (playedFrom > 0 && Date.now() / 1000 < earliest) {
    console.warn("[settle] refused: match not yet played", { id: id.toString(), startedAt: playedFrom, earliest });
    throw new HttpError(409, "the match has not been played yet");
  }

  const stakers = collectedPlayers(m!).map((k) => k.toBase58());
  // Every staker is on the room's board, quitters included (their rat stays
  // in the arena). One missing is worth a line in the log, not a refusal.
  const ranked = new Set(ranking.map((w) => w.toBase58()));
  const unranked = stakers.filter((s) => !ranked.has(s));
  if (unranked.length) console.warn("[settle] stakers missing from the ranking", { id: id.toString(), missing: unranked.length });

  // Every payout carries the room server's signature over its ranking, and
  // the program picks the podium and the referrals itself (api/_settle.ts;
  // escrow v3, live since 2026-10-08). Without the room's key on chain there
  // is nothing that can pay: refused, and the room asks again.
  if (!ownedByEscrow(await p.provider.connection.getAccountInfo(guardPda(), "confirmed"), 8 + 32 + 1)) {
    throw new HttpError(503, "the escrow has no room key");
  }
  const paid = await paySigned(p, id, m!, body.signed);
  const out = await record(id, stakers, ranking.map((w) => w.toBase58()), paid, BigInt(m!.entry.toString()));
  if (out.recorded) await sendClose(p, id, m!.feeWallet);
  return out;
}, { signed: true });

/**
 * Rent back, sent and not waited for: the room is waiting on this answer, and
 * a close that never lands costs the authority a little SOL. Only once the
 * record is in: a closed match no longer says what its entry was, so a
 * record retried after the close could not rebuild a match row lost when the
 * match opened (full audit, 2026-10-09). Until then the match stays settled
 * on chain, and the room's next call writes the record and closes it.
 */
async function sendClose(p: EscrowProgram, id: bigint, feeWallet: PublicKey): Promise<void> {
  try {
    const auth = authority();
    const conn = p.provider.connection;
    const tx = await p.methods
      .closeMatch(toBn(id))
      .accountsPartial({ authority: auth.publicKey, mint: mint(), feeAta: ata(feeWallet), tokenProgram: TOKEN_PROGRAM_ID })
      .transaction();
    tx.feePayer = auth.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(auth);
    await conn.sendRawTransaction(tx.serialize());
  } catch {
    /* rent only */
  }
}

/**
 * The settlement of match `id`, from its MatchSettled event on chain, or
 * null if the match's history has none. The referral payments are paired
 * back with the finishers who earned them through the database; if it
 * cannot be read they are left out, and record() reports the gap.
 */
async function findSettlement(p: EscrowProgram, id: bigint, hint?: string): Promise<(Payout & { unpaired: boolean }) | null> {
  const conn = p.provider.connection;
  // This version's receipts first, then v3's (no referred list): a reader of
  // one cannot read the other.
  const parsers = [new EventParser(p.programId, p.coder), new EventParser(p.programId, new BorshCoder(IDL_V3 as unknown as Idl))];
  const eventsIn = (logs: string[]) => {
    for (const parser of parsers) {
      try {
        const evs = [...parser.parseLogs(logs)];
        if (evs.some((ev) => ev.name.toLowerCase() === "matchsettled")) return evs;
      } catch {
        /* the other version's receipt */
      }
    }
    return [];
  };
  // One transaction, read for this match's payout (MatchSettled, this id).
  const readOne = async (signature: string): Promise<(Payout & { unpaired: boolean }) | null> => {
    const tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    for (const ev of eventsIn(tx?.meta?.logMessages ?? [])) {
      // "matchSettled" or "MatchSettled", by which IDL the coder was built from.
      if (ev.name.toLowerCase() !== "matchsettled") continue;
      const d = ev.data as Record<string, unknown>;
      if (String(d.id) !== id.toString()) continue;
      const keys = (v: unknown) => ((v as PublicKey[] | undefined) ?? []).map((k) => k.toBase58());
      const nums = (v: unknown) => ((v as { toString(): string }[] | undefined) ?? []).map((n) => BigInt(n.toString()));
      const winners = keys(d.winners);
      const referrers = keys(d.referrers);
      const referralAmounts = nums(d.referral_amounts ?? d.referralAmounts);
      // The program paid one referrer for each podium finisher with an
      // invite record on chain, in podium order. Paired here from those
      // records, which never change; but one can be written after the payout,
      // so unless the winners with a record now are exactly as many as the
      // referrers paid, and each matches, nothing is attributed (the earnings
      // are left unrecorded rather than credited to the wrong friend).
      const referred: Payout["referred"] = [];
      let unpaired = false;
      // Since v4 the receipt names the winner each referrer was paid for.
      const named = keys(d.referred);
      if (referrers.length && named.length === referrers.length) {
        named.forEach((friend, k) => referred.push({ friend, referrer: referrers[k], amount: referralAmounts[k] ?? 0n }));
      } else if (referrers.length) {
        const infos = await conn.getMultipleAccountsInfo(winners.map((w) => referralPda(new PublicKey(w))), "confirmed");
        const recorded = winners
          .map((w, i) => {
            const info = infos[i];
            if (!info || !ownedByEscrow(info, 8 + 32 + 1)) return null;
            const r = p.coder.accounts.decode("referral", info.data) as { referrer: PublicKey };
            return { friend: w, referrer: r.referrer.toBase58() };
          })
          .filter((r): r is { friend: string; referrer: string } => !!r);
        if (recorded.length === referrers.length && recorded.every((r, k) => r.referrer === referrers[k])) {
          recorded.forEach((r, k) => referred.push({ ...r, amount: referralAmounts[k] ?? 0n }));
        } else {
          unpaired = true;
        }
      }
      return {
        signature,
        pool: BigInt(String(d.pool)),
        fee: BigInt(String(d.fee)),
        winners,
        amounts: nums(d.amounts),
        referred,
        unpaired,
      };
    }
    return null;
  };
  // The payout the room already saw, when it says so: read first, directly.
  if (hint) {
    const got = await readOne(hint).catch(() => null);
    if (got) return got;
  }
  // The match's whole history, not only its last fifty entries: anyone can
  // name the match's account in transactions of their own, and fifty of them
  // hid the payout from this search for good (review, 2026-10-12). The last
  // fifty first, where a payout normally is (it and the close are the
  // newest); then the rest from the start, where the payout comes within the
  // match's own short history however much was added after it. Bounded.
  const sigs: Awaited<ReturnType<typeof conn.getSignaturesForAddress>> = [];
  for (let before: string | undefined, page = 0; page < 20; page++) {
    const batch = await conn.getSignaturesForAddress(matchPda(id), { limit: 1000, before });
    sigs.push(...batch);
    if (batch.length < 1000) break;
    before = batch[batch.length - 1].signature;
  }
  const order = [...sigs.slice(0, 50), ...sigs.slice(50).reverse()];
  let looked = 0;
  for (const s of order) {
    if (++looked > 400) break;
    if (s.err) continue;
    const got = await readOne(s.signature);
    if (got) return got;
  }
  return null;
}

/**
 * Write the payout down (the match, every staker's result, the referral
 * earnings) and shape the answer. All writes are upserts, so a second call
 * for the same match rewrites the same rows.
 */
async function record(id: bigint, stakers: string[], ranking: string[], pay: Payout & { unpaired?: boolean }, entry?: bigint) {
  const paid: Record<string, number> = {};
  pay.winners.forEach((w, i) => (paid[w] = Number(pay.amounts[i] ?? 0n)));

  // Every staker gets a row: the podium in the order paid, then the rest in
  // the order the ranking gave them, then anyone the ranking left out.
  // Skulls follow the finishing position, as they do on the client.
  const order: string[] = [];
  for (const s of [...pay.winners, ...ranking]) {
    if (stakers.includes(s) && !order.includes(s)) order.push(s);
  }
  for (const s of stakers) if (!order.includes(s)) order.push(s);
  const rows = order.map((wallet, i) => ({
    match_id: id.toString(),
    wallet,
    rank: i + 1,
    payout: usdc(paid[wallet] ?? 0),
    skulls: skullsForRank(i + 1),
  }));
  // Awaited, all of them: Vercel suspends a function the moment it has
  // responded, and a write still in flight is a write that never happens.
  // None can throw (see _db.ts); each says whether it landed.
  //
  // The match row is written whole when the chain still says what it was:
  // a row lost when the match opened (a database blip) used to stay lost,
  // the update matching nothing and every result refused for want of it
  // (review 2026-10-06, DB-05).
  const settled = { state: "settled", fee: usdc(pay.fee), pool: usdc(pay.pool), stakers: stakers.length, signature: pay.signature, settled_at: new Date().toISOString() };
  const tier = entry === undefined ? undefined : PRICE_TIERS.find((t) => entryUnits(t) === entry);
  const wrote = [
    tier && entry !== undefined
      ? await dbUpsert("matches", { id: id.toString(), tier: tier.id, entry: usdc(entry), ...settled })
      : await dbUpdate("matches", { id: id.toString() }, settled),
    await dbUpsert("results", rows),
  ];
  // What each referrer earned from this match: the referral board's figures.
  if (pay.referred.length) {
    wrote.push(
      await dbUpsert(
        "referral_earnings",
        pay.referred.map((r) => ({
          match_id: id.toString(),
          referred_wallet: r.friend,
          referrer_wallet: r.referrer,
          amount: usdc(r.amount),
        })),
      ),
    );
  }
  // Referrals that could not be paired do not hold the match open: a record
  // written after the payout never goes away, so writing again never pairs
  // them, and waiting on it kept the match's rent from coming back (security
  // review, 2026-10-13). Logged instead, to be credited by hand.
  const recorded = !DB_ENABLED || wrote.every(Boolean);
  if (!recorded) console.error("[settle] paid, but the record is incomplete; the room will write it again", { id: id.toString() });
  if (pay.unpaired) console.error("[settle] referral earnings left unrecorded: could not pair them with the podium", { id: id.toString(), signature: pay.signature });

  return {
    pool: Number(pay.pool),
    fee: Number(pay.fee),
    amounts: paid,
    referrals: pay.referred.map((r) => ({ referrer: r.referrer, friend: r.friend, amount: Number(r.amount) })),
    signature: pay.signature,
    recorded,
  };
}

/** The Android app asks before it posts; see preflight in _lib. */
export const OPTIONS = preflight;
