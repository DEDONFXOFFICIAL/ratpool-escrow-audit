import { Transaction } from "@solana/web3.js";
import { withinLimit } from "../_db.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import { TOKEN_PROGRAM_ID } from "../../src/chain/escrow.js";
import { requireFeeFunds, preflight, ata, authority, connection, endpoint, HttpError, ipKey, mint, parsePubkey, requireOutsideWallet, requireWalletProof, USDC_DECIMALS } from "../_lib.js";
import { sendDetail } from "../../src/chain/walletRequest.js";

/**
 * POST /api/wallet/transfer  { from, to, amount, proof }
 *   →  { tx, blockhash, lastValidBlockHeight }
 *
 * USDC out of the platform wallet, to any address the player names, with
 * the platform paying the fee — the same shape as the sponsored join
 * (api/match/sponsor.ts): built here, co-signed here, signed and sent by
 * the player's wallet, which cannot change a thing without voiding this
 * signature. What it does is one token transfer from the player's own
 * account, so the only money that can move is theirs, and only where they
 * said.
 *
 * Self-custody made functional (owner, 2026-09-16): a wallet the player
 * cannot send from is a balance, not a wallet. The receiving side needs no
 * server at all — the address is the address.
 *
 * The receiver's token account is created if it does not exist, at the
 * platform's expense, because "send to a fresh wallet" has to work. That
 * rent is a cost a player could run up on purpose, so new destinations
 * have a separate daily limit.
 */
/** Devnet confirmations can crawl; a function cut off mid-transaction is the worst outcome. */
export const maxDuration = 60;

export const POST = endpoint(async (body, req) => {
  const from = parsePubkey(body.from);
  const to = parsePubkey(body.to);
  requireOutsideWallet(from);
  if (from.equals(to)) throw new HttpError(400, "That is this wallet's own address");
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, "Enter an amount");
  const units = BigInt(Math.round(amount * 10 ** USDC_DECIMALS));
  if (units <= 0n) throw new HttpError(400, "Enter an amount");
  // Only the wallet itself can ask: nothing is built or counted for a request
  // in another player's name.
  await requireWalletProof(body, from, "send", sendDetail(body.to, body.amount));

  // Per wallet, per network and overall: a wallet costs nothing to make, so
  // tiny amounts passed round a ring of fresh wallets spent the platform's fee
  // money thirty transfers per wallet per hour, without end (review,
  // 2026-10-12). Sends are rare for a player; these leave room for many.
  if (
    !await withinLimit(`xfer:w:${from.toBase58()}`, 30, 3600) ||
    !await withinLimit(`xfer:ip:${ipKey(req!)}`, 120, 3600) ||
    !await withinLimit("xfer:all", 3000, 3600)
  ) {
    throw new HttpError(429, "Too many transfers — try again later.");
  }

  const conn = connection();
  const auth = authority();
  await requireFeeFunds(conn, auth.publicKey);
  const m = mint();
  const source = ata(from);
  const held = await getAccount(conn, source).then(
    (a) => a.amount,
    () => 0n,
  );
  if (held < units) {
    throw new HttpError(400, `Only ${(Number(held) / 10 ** USDC_DECIMALS).toFixed(2)} USDC to send`);
  }

  const destination = getAssociatedTokenAddressSync(m, to, true, TOKEN_PROGRAM_ID);
  const info = await conn.getAccountInfo(destination);
  const missing = !info;
  // An account that is there must still be the address's own: one whose owner
  // was changed would have paid that new owner, not the address the player
  // typed (review 2026-10-07).
  if (info) {
    let usable = false;
    try {
      const acct = unpackAccount(destination, info, TOKEN_PROGRAM_ID);
      usable = acct.owner.equals(to) && acct.mint.equals(m) && !acct.isFrozen;
    } catch {
      usable = false;
    }
    if (!usable) throw new HttpError(400, "That address can't receive USDC.");
  }
  // A new account's rent is the platform's, and whoever owns the account gets
  // it back by closing it: fresh wallets in a loop turned that into SOL out of
  // the platform (review 2026-10-06). Per wallet, per network and overall.
  if (
    missing &&
    (!await withinLimit(`xfer:new:${from.toBase58()}`, 5, 86400) ||
      !await withinLimit(`xfer:new:ip:${ipKey(req!)}`, 10, 86400) ||
      !await withinLimit("xfer:new:all", 60, 86400))
  ) {
    throw new HttpError(429, "Too many new destinations — try again later.");
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: auth.publicKey, blockhash, lastValidBlockHeight });
  // Only when missing: a new account's rent is the platform's, counted above.
  if (missing) {
    tx.add(createAssociatedTokenAccountIdempotentInstruction(auth.publicKey, destination, to, m, TOKEN_PROGRAM_ID));
  }
  tx.add(createTransferCheckedInstruction(source, m, destination, from, units, USDC_DECIMALS, [], TOKEN_PROGRAM_ID));
  tx.partialSign(auth);
  return {
    tx: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    blockhash,
    lastValidBlockHeight,
  };
});

/** The Android app asks before it posts; see preflight in _lib. */
export const OPTIONS = preflight;
