import { Transaction } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { withinLimit } from "../_db.js";
import { enumKey, matchPda, toBn, TOKEN_PROGRAM_ID } from "../../src/chain/escrow.js";
import { requireFeeFunds, preflight, admitted, ata, connection, endpoint, HttpError, ipKey, parseId, parsePubkey, program, requireOutsideWallet, requireWalletProof, sponsor } from "../_lib.js";
import { leaveDetail } from "../../src/chain/walletRequest.js";

/**
 * POST /api/match/sponsor  { id, player, action: "join" | "leave", admitExp?, admitSig?, proof? }
 *   →  { tx, blockhash, lastValidBlockHeight }
 *
 * The player's two transactions, with the platform paying the fee. A tester
 * arrives with test USDC from the faucet and no SOL, and should never need
 * any: the sponsor key is the fee payer here (and the program's admission
 * signer on a join). (Owner, 2026-09-16: "we are funding the transaction and
 * the platform entirely.")
 *
 * The sponsor signs only what it built. The message is assembled here —
 * one instruction, join or leave, for this id and this player — and
 * partially signed; the player's wallet adds the second signature and
 * sends. Anything changed in between invalidates the authority's signature,
 * so a co-signed transaction can never carry an instruction this file did
 * not write. Wallet and IP limits keep repeated requests from draining
 * the platform.
 */
export const POST = endpoint(async (body, req) => {
  const id = parseId(body.id);
  const player = parsePubkey(body.player);
  // Named as the player, the authority would have joined or left pools
  // with its own signature on it, for anyone who asked.
  requireOutsideWallet(player);
  const action = body.action;
  if (action !== "join" && action !== "leave") throw new HttpError(400, "action must be join or leave");

  // A seat on chain only for a seat in the room: the program now needs the
  // sponsor's signature on every join (escrow v2), and the sponsor gives it
  // only against the room's ticket for this match and this wallet. Without
  // it, fifty throwaway wallets could fill a match's seats (review C02).
  if (action === "join" && !admitted(id, player, body.admitExp, body.admitSig)) {
    throw new HttpError(403, "Rejoin the pool to take your seat.");
  }
  // A leave only for a wallet the chain has in this match. Checked before
  // any limit is counted: naming someone else's wallet used to spend that
  // player's allowance and lock them out of pools (review R16).
  if (action === "leave") {
    // Counted per network before the signature is checked and its one-time
    // number stored, and before the chain is read (security review, round
    // two). Per network only: nothing here can spend a player's own allowance.
    if (!await withinLimit(`sponsor:ipleave:${ipKey(req!)}`, 600, 3600)) throw new HttpError(429, "Too many requests — try again later.");
    // Asked for by the wallet itself, never in its name (review 2026-10-06).
    await requireWalletProof(body, player, "leave", leaveDetail(id));
    const m = await program().account.match.fetchNullable(matchPda(id));
    const seated = m?.players.some((pl) => pl.key.equals(player) && enumKey(pl.status) === "joined");
    if (!seated) throw new HttpError(409, "Not in this pool.");
    // Asked for before the first lands, every leave after it fails on chain
    // and still costs the sponsor its fee: counted per wallet (only the
    // wallet itself gets this far, so nobody can spend another's) and
    // overall, kept locally when the database cannot answer so a player can
    // always leave (outside report, 2026-10-18).
    if (!await withinLimit(`sponsor:wleave:${player.toBase58()}`, 20, 3600) || !await withinLimit("sponsor:leaveall", 3000, 3600)) {
      throw new HttpError(429, "Too many requests — try again later.");
    }
  }

  // The wallet's own allowance is counted for joins only, which carry the
  // room's ticket. A leave can be sent by nobody but that player, so it costs
  // the platform nothing until they do; counting it let anyone use up a
  // seated player's allowance by asking for leaves in their name (R16).
  // Leaves count on a separate, larger network allowance (above): on a
  // shared network (a mobile carrier puts many players behind one address) a
  // flood of leave requests must not use up the allowance joins depend on.
  if (
    action === "join" &&
    (!await withinLimit(`sponsor:w:${player.toBase58()}`, 60, 3600) || !await withinLimit(`sponsor:ip:${ipKey(req!)}`, 200, 3600))
  ) {
    throw new HttpError(429, "Too many requests — try again later.");
  }

  const conn = connection();
  const payer = sponsor();
  await requireFeeFunds(conn, payer.publicKey);
  const p = program();
  // A join only when it can land: an open match without this wallet in it,
  // and the entry in the wallet's own usable account. A join that fails on
  // chain still costs the sponsor its fee, and wallets without the entry
  // made that free to repeat (security review, 2026-10-14). Then counted
  // overall, once it can go through.
  if (action === "join") {
    const m = await p.account.match.fetchNullable(matchPda(id));
    if (!m || enumKey(m.state) !== "open") throw new HttpError(409, "This pool is no longer open.");
    if (m.players.some((pl) => pl.key.equals(player) && enumKey(pl.status) === "joined")) throw new HttpError(409, "Already in this pool.");
    const src = await getAccount(conn, ata(player)).catch(() => null);
    if (!src || !src.owner.equals(player) || src.isFrozen || src.amount < BigInt(m.entry.toString())) {
      throw new HttpError(400, "Not enough USDC in this wallet for the entry.");
    }
    // One room ticket, a few joins at most (a retry after a lost answer),
    // not a seat taken again and again after leaving (outside report,
    // 2026-10-18). Its window outlasts the ticket's own.
    if (!await withinLimit(`admit:${id}:${player.toBase58()}:${body.admitExp}`, 3, 600)) {
      throw new HttpError(403, "Rejoin the pool to take your seat.");
    }
    if (!await withinLimit("sponsor:all", 6000, 3600)) throw new HttpError(429, "Too many requests — try again later.");
  }
  const accounts = { playerAta: ata(player), player, tokenProgram: TOKEN_PROGRAM_ID };
  const ix =
    action === "join"
      ? await p.methods.join(toBn(id)).accountsPartial({ ...accounts, admission: payer.publicKey }).instruction()
      : await p.methods.leave(toBn(id)).accountsPartial(accounts).instruction();

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(ix);
  tx.partialSign(payer);
  return {
    tx: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    blockhash,
    lastValidBlockHeight,
  };
});

/** The Android app asks before it posts; see preflight in _lib. */
export const OPTIONS = preflight;
