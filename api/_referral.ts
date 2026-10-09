import { randomInt } from "node:crypto";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { connection, HttpError, ipKey, parsePubkey, program, signedBy, sponsor } from "./_lib.js";
import { DB_ENABLED, dbInsertNew, dbPatch, dbSelect, withinLimit } from "./_db.js";
import { guardPda, ownedByEscrow, referralPda } from "../src/chain/escrow.js";

/**
 * POST /api/profile with a referral message  →  see below  (routed by
 * api/profile.ts; a function of its own would pass the plan's limit of twelve)
 *
 * Referrals: who brought whom. Nothing here moves money: the reward, 1% of a
 * pool shared by the podium players' referrers, is paid by the escrow program
 * at settlement (api/match/settle.ts) and recorded in referral_earnings. The
 * tables are in supabase/2026-09-29-limits-and-referrals.sql and
 * 2026-09-30-earnings-purchases-privacy.sql; a browser can neither read nor
 * write them.
 *
 * Two messages, each signed by the wallet it names (the proof the profile
 * already uses, silent with the in-app wallet):
 *
 *   RatPool referral             → { code, invited, verified, recent }
 *   wallet: <base58>               the player's own code, made on first ask,
 *   issued: <ISO time>             and who has used it
 *
 *   RatPool referral claim       → { ok, verified }
 *   wallet: <base58>               a new player says who invited them
 *   code: <CODE>
 *   issued: <ISO time>
 *
 * A claim is refused for your own code, a code that does not exist, a player
 * who already has a referrer (the table's key, so the first claim stands and
 * cannot be overwritten), and a player who is not new: one who has played a
 * pool, or whose rat is more than a week old. It is verified once the new
 * player has signed in and built their rat, which a download alone never
 * does; a claim made before the rat exists is verified when the rat is saved
 * (verifyReferral, called from api/profile.ts).
 *
 * Since the escrow pays referrals only to referrers recorded on chain
 * (settle_signed, 2026-10-08), a claim's answer also carries `record` while
 * the invite is not on chain yet: a transaction recording it (set_referrer),
 * built and paid for by the platform, for the player's wallet to sign. The
 * game signs it only for the inviter the player chose when they claimed
 * (src/state/store.tsx), so the stats answer can offer it again after a
 * failed try without the site choosing for them. Invites made before are
 * carried over by the owner (UPGRADE-v3).
 * Nothing moves; the record is written once and never changes.
 */
const MAX_AGE_MS = 10 * 60 * 1000;
/** No 0/O or 1/I/L to misread off a friend's screen. */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;
/** A rat older than this belongs to a player who is not new. */
const NEW_PLAYER_MS = 7 * 24 * 3600 * 1000;

const busy = () => new HttpError(502, "Can't reach invites right now. Try again in a minute.");

export function isReferralMessage(message: string): boolean {
  return message.startsWith("RatPool referral\n") || message.startsWith("RatPool referral claim\n");
}

export async function referralMessage(body: Record<string, unknown>, req?: Request): Promise<unknown> {
  if (!DB_ENABLED) throw new HttpError(503, "no database configured");
  const { message, signature } = body;
  if (typeof message !== "string" || typeof signature !== "string") throw new HttpError(400, "message and signature required");
  if (message.length > 512) throw new HttpError(413, "message too large");
  const lines = message.split("\n");
  const field = (k: string) => {
    const l = lines.find((x) => x.startsWith(k + ": "));
    return l ? l.slice(k.length + 2) : null;
  };
  const wallet = parsePubkey(field("wallet"));
  const issued = Date.parse(field("issued") ?? "");
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > MAX_AGE_MS) throw new HttpError(400, "signature too old");
  if (!signedBy(wallet, message, signature)) throw new HttpError(401, "signature does not match the wallet");
  const w = wallet.toBase58();
  if (lines[0] === "RatPool referral") return withRecord(w, await myReferral(w));
  if (lines[0] === "RatPool referral claim") return withRecord(w, await claim(w, field("code"), req));
  throw new HttpError(400, "not a referral message");
}

/** The player's code, made the first time they ask, and who has used it. */
async function myReferral(w: string) {
  const codeOf = async () => (await dbSelect<{ code: string }>(`referral_codes?wallet=eq.${w}&select=code`))?.[0]?.code ?? null;
  let code = await codeOf();
  for (let tries = 0; !code && tries < 6; tries++) {
    const candidate = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    const r = await dbInsertNew("referral_codes", { wallet: w, code: candidate });
    if (r === "ok") code = candidate;
    else if (r === "exists") code = await codeOf(); // this wallet got one a moment ago, or the code was taken: ask again
    else throw busy();
  }
  if (!code) throw busy();

  // Totals from the database's own sums (the referral board), not from the
  // rows fetched: a fetch is capped at the database's page size, so long
  // lists used to come back short (review 2026-10-07). Only what the screen
  // shows is fetched as rows.
  const totals = await dbSelect<{ earned: number; joined: number; invited: number }>(
    `referral_board?wallet=eq.${w}&select=earned,joined,invited&limit=1`,
  );
  const rows = await dbSelect<{ referred_wallet: string; created_at: string; verified_at: string | null }>(
    `referrals?referrer_wallet=eq.${w}&select=referred_wallet,created_at,verified_at&order=created_at.desc&limit=10`,
  );
  if (!rows || !totals) throw busy();
  // What their invites have earned them (api/match/settle.ts writes it).
  const earnedRows =
    (await dbSelect<{ match_id: string; amount: number; created_at: string }>(
      `referral_earnings?referrer_wallet=eq.${w}&select=match_id,amount,created_at&order=created_at.desc&limit=30`,
    )) ?? [];
  const earned = +Number(totals[0]?.earned ?? 0).toFixed(6);
  // The last few, by the name of their rat where they have one.
  const recent = rows;
  const names = recent.length
    ? await dbSelect<{ wallet: string; name: string }>(
        `profiles?wallet=in.(${recent.map((r) => r.referred_wallet).join(",")})&select=wallet,name`,
      )
    : [];
  const nameOf = new Map((names ?? []).map((p) => [p.wallet, p.name]));
  return {
    code,
    invited: Number(totals[0]?.invited ?? 0),
    verified: Number(totals[0]?.joined ?? 0),
    earned,
    // Each payout on its own, for the player's history.
    rewards: earnedRows.map((r, i) => ({
      id: `${r.match_id}:${i}`,
      amount: +Number(r.amount).toFixed(6),
      at: r.created_at,
    })),
    recent: recent.map((r) => ({
      name: nameOf.get(r.referred_wallet) ?? `${r.referred_wallet.slice(0, 4)}…${r.referred_wallet.slice(-4)}`,
      at: r.created_at,
      verified: !!r.verified_at,
    })),
  };
}

/** A new player names the friend who invited them. */
async function claim(w: string, raw: string | null, req?: Request) {
  const code = (raw ?? "").trim().toUpperCase();
  if (!CODE_RE.test(code)) throw new HttpError(400, "That code doesn't exist.");
  if (
    !(await withinLimit(`refclaim:w:${w}`, 5, 3600)) ||
    (req && !(await withinLimit(`refclaim:ip:${ipKey(req)}`, 10, 86400)))
  ) {
    throw new HttpError(429, "Too many tries. Try again later.");
  }
  const owner = await dbSelect<{ wallet: string }>(`referral_codes?code=eq.${code}&select=wallet`);
  if (!owner) throw busy();
  if (!owner.length) throw new HttpError(400, "That code doesn't exist.");
  const referrer = owner[0].wallet;
  if (referrer === w) throw new HttpError(400, "That's your own code.");
  // The same code again, from a player whose claim stands: answered as
  // before (its on-chain record offered again), whatever has happened since.
  const mine = await dbSelect<{ referrer_wallet: string; verified_at: string | null }>(
    `referrals?referred_wallet=eq.${w}&select=referrer_wallet,verified_at&limit=1`,
  );
  if (!mine) throw busy();
  if (mine[0]) {
    if (mine[0].referrer_wallet === referrer) return { ok: true, verified: !!mine[0].verified_at, referrer };
    throw new HttpError(409, "You already have an invite code.");
  }
  // No allowance counted against the referrer: their code is public, so a
  // count in their name let strangers use it up and turn their real friends
  // away (review 2026-10-06). Claims are limited per claimant and network;
  // one person inviting their own wallets is allowed (owner, 2026-10-06).

  // New players only: nothing played for stakes, and a rat (if any) under a week old.
  const played = await dbSelect<{ match_id: string }>(`results?wallet=eq.${w}&select=match_id&limit=1`);
  const rat = await dbSelect<{ created_at: string }>(`profiles?wallet=eq.${w}&select=created_at&limit=1`);
  if (!played || !rat) throw busy();
  const built = rat[0];
  if (played.length || (built && Date.now() - Date.parse(built.created_at) > NEW_PLAYER_MS)) {
    throw new HttpError(409, "Invite codes are for new players.");
  }
  const r = await dbInsertNew("referrals", {
    referred_wallet: w,
    referrer_wallet: referrer,
    code,
    verified_at: built ? new Date().toISOString() : null,
  });
  if (r === "exists") throw new HttpError(409, "You already have an invite code.");
  if (r === "error") throw busy();
  return { ok: true, verified: !!built, referrer };
}

/**
 * The answer, with the transaction that records this player's invite on
 * chain when there is one to record: the escrow knows about invites
 * (the guard exists), this player was invited, and the record is not there
 * yet. Left out on any trouble; asked again next time.
 */
async function withRecord<T extends object>(
  w: string,
  answer: T,
): Promise<T & { record?: { tx: string; referrer: string; blockhash: string; lastValidBlockHeight: number } }> {
  try {
    if (!(await withinLimit(`refrecord:w:${w}`, 20, 3600))) return answer;
    const row = await dbSelect<{ referrer_wallet: string }>(`referrals?referred_wallet=eq.${w}&select=referrer_wallet&limit=1`);
    const referrer = row?.[0]?.referrer_wallet;
    if (!referrer) return answer;
    const player = new PublicKey(w);
    const conn = connection();
    const [guard, existing] = await conn.getMultipleAccountsInfo([guardPda(), referralPda(player)], "confirmed");
    if (!ownedByEscrow(guard, 8 + 32 + 1) || ownedByEscrow(existing, 8 + 32 + 1)) return answer;
    const payer = sponsor();
    const ix = await program()
      .methods.setReferrer(new PublicKey(referrer))
      .accountsPartial({ referral: referralPda(player), player, payer: payer.publicKey, systemProgram: SystemProgram.programId })
      .instruction();
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(ix);
    tx.partialSign(payer);
    return { ...answer, record: { tx: tx.serialize({ requireAllSignatures: false }).toString("base64"), referrer, blockhash, lastValidBlockHeight } };
  } catch (e) {
    console.warn("[referral] no on-chain record offered:", (e as Error).message);
    return answer;
  }
}

/** This wallet's rat was just saved: a claim that was waiting on it is verified. */
export async function verifyReferral(wallet: string): Promise<void> {
  await dbPatch(`referrals?referred_wallet=eq.${wallet}&verified_at=is.null`, { verified_at: new Date().toISOString() });
}
