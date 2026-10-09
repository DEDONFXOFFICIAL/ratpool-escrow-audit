import { Transaction } from "@solana/web3.js";
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
    // Asked for by the wallet itself, never in its name (review 2026-10-06).
    await requireWalletProof(body, player, "leave", leaveDetail(id));
    const m = await program().account.match.fetchNullable(matchPda(id));
    const seated = m?.players.some((pl) => pl.key.equals(player) && enumKey(pl.status) === "joined");
    if (!seated) throw new HttpError(409, "Not in this pool.");
  }

  // The wallet's own allowance is counted for joins only, which carry the
  // room's ticket. A leave can be sent by nobody but that player, so it costs
  // the platform nothing until they do; counting it let anyone use up a
  // seated player's allowance by asking for leaves in their name (R16).
  // Leaves count on a separate, larger network allowance: on a shared
  // network (a mobile carrier puts many players behind one address) a flood
  // of leave requests must not use up the allowance that joins depend on.
  if (
    (action === "join" && !await withinLimit(`sponsor:w:${player.toBase58()}`, 60, 3600))
    || !await withinLimit(`sponsor:${action === "join" ? "ip" : "ipleave"}:${ipKey(req!)}`, action === "join" ? 200 : 600, 3600)
  ) {
    throw new HttpError(429, "Too many requests — try again later.");
  }

  const conn = connection();
  const payer = sponsor();
  await requireFeeFunds(conn, payer.publicKey);
  const p = program();
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
