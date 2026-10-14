import { SystemProgram } from "@solana/web3.js";
import { toBn, TOKEN_PROGRAM_ID } from "../../src/chain/escrow.js";
import { MATCH_RENT_LAMPORTS, requireFeeFunds, preflight, ata, connection, authority, endpoint, entryUnits, HttpError, mint, newMatchId, parsePubkey, program, tierById } from "../_lib.js";
import { DB_ENABLED, dbUpsert, usdc, withinLimit, withinSharedLimit } from "../_db.js";

/**
 * POST /api/match/open  { tier }  →  { id, entry }
 *
 * Opens a room on chain for the tier. The authority pays the rent for the
 * match and vault accounts and gets it back at close. One room per human
 * for now — the lobby beneath it is the client's simulated one — which is
 * what the game server replaces with real rooms of ten.
 */
/** Devnet confirmations can crawl; a function cut off mid-transaction is the worst outcome. */
export const maxDuration = 60;

export const POST = endpoint(async (body) => {
  const tier = tierById(body.tier);
  if (!tier) throw new HttpError(400, "unknown tier");
  // When the balance was read, not when its answer came: a slow answer must
  // not move an opening into a window apart from one that read the same.
  const at = Math.floor(Date.now() / 1000);
  const balance = await requireFeeFunds(connection(), authority().publicKey, 10_000_000 + MATCH_RENT_LAMPORTS);
  const id = newMatchId();
  const entry = entryUnits(tier);
  // The room names the player it is opening for; a wallet without the entry
  // does not get a match opened at the platform's expense (review R08).
  // Only a balance read as short (or no USDC account at all) refuses: a
  // network error must not turn an honest player away.
  if (body.wallet !== undefined) {
    let balance: bigint | null = null;
    try {
      balance = BigInt((await connection().getTokenAccountBalance(ata(parsePubkey(body.wallet)))).value.amount);
    } catch (e) {
      if (/could not find account/i.test(String((e as Error)?.message))) balance = 0n;
    }
    if (balance !== null && balance < entry) throw new HttpError(402, "not enough USDC for this pool");
    // Opening and walking away costs the platform fees each time, even with
    // the rent coming back: a wallet opens a handful of pools an hour at most.
    if (!(await withinLimit(`open:w:${parsePubkey(body.wallet).toBase58()}`, 12, 3600))) throw new HttpError(402, "too many pools opened; try again later");
  }
  if (!(await withinLimit("open:all", 600, 3600))) throw new HttpError(503, "Can't open a pool right now. Try again in a minute.");
  // Openings at the same moment all read the balance before any has paid its
  // rent, so each passed the check above and together they could take the
  // platform below what cleanup needs (security review, 2026-10-13). Counted
  // across every instance: no more openings in two minutes than the balance
  // covers with the floor left over. Two windows, half a window apart, so
  // openings under a minute apart (longer than one can take: maxDuration)
  // always share one, whenever a window turns over. Well above the floor this
  // is dozens; only near it does it refuse, a little early rather than late.
  // Counted last, after the wallet's own checks: wallets without the entry
  // used to use it up (security review, round two).
  const covers = Math.floor((balance - 10_000_000) / MATCH_RENT_LAMPORTS);
  // Near the floor (fewer than ten openings left) only the shared count will
  // do, and none when the database cannot answer; well above it, a database
  // blip must not stop matches opening, so each instance counts for itself.
  const count = covers < 10 ? withinSharedLimit : withinLimit;
  for (const [i, window] of [Math.floor(at / 120), Math.floor((at + 60) / 120)].entries()) {
    if (!await count(`open:rent:${i}:${window}`, covers, 180)) {
      console.error("[api] openings would pass the SOL floor", { balance, covers });
      throw new HttpError(503, "Can't do that right now. Try again in a minute.");
    }
  }
  await program()
    .methods.createMatch(toBn(id), toBn(entry))
    .accountsPartial({
      mint: mint(),
      authority: authority().publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  // A few tries before giving up on the record; the match is open on chain
  // either way, and settlement writes the row whole if this one never landed.
  const row = { id: id.toString(), tier: tier.id, entry: usdc(entry), state: "open" };
  for (let i = 0; DB_ENABLED && i < 3 && !(await dbUpsert("matches", row)); i++) {
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  return { id: id.toString(), entry: Number(entry) };
}, { signed: true });

/** The Android app asks before it posts; see preflight in _lib. */
export const OPTIONS = preflight;
