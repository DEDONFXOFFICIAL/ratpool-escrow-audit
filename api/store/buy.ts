import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { dbInsertNew, dbSelect, withinLimit, withinSharedLimit } from "../_db.js";
import { PAST_STORE_TREASURIES, purchaseMemo, STORE_PRICES } from "../../src/economy/prices.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
} from "@solana/spl-token";
import { TOKEN_PROGRAM_ID } from "../../src/chain/escrow.js";
import { requireFeeFunds, preflight, ata, authority, connection, endpoint, HttpError, ipKey, mint, parsePubkey, program, requireOutsideWallet, requireWalletProof, USDC_DECIMALS } from "../_lib.js";
import { buyDetail } from "../../src/chain/walletRequest.js";
import { configPda } from "../../src/chain/escrow.js";

/**
 * POST /api/store/buy  { from, item | amount, proof }
 *   →  { tx, blockhash, lastValidBlockHeight }
 *
 * Buy a store item with USDC. The same shape as the sponsored transfer
 * (api/wallet/transfer.ts): the platform builds the transaction with itself
 * as fee payer, co-signs its half, and the player's wallet signs and sends —
 * so a player needs test USDC and no SOL, and the wallet cannot change a
 * thing without voiding the platform's signature. What moves is one token
 * transfer out of the player's own account, to the platform treasury, for
 * the amount the store named.
 *
 * The money goes to the platform's revenue wallet, the escrow config's fee
 * wallet (the owner's, set 2026-09-30), read from the chain so there is one
 * place it is decided. The authority only pays the fee (and the rent for the
 * revenue wallet's token account, the first time).
 */
/** Devnet confirmations can crawl; a function cut off mid-transaction is the worst outcome. */
export const maxDuration = 60;

/** The memo program: a note on the payment naming what it bought. */
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
// A payment is recorded whenever it comes, however old: its signature is
// recorded once, and it must match the item's price, memo, wallet and
// treasury exactly, so age adds nothing to safety. A window (an hour, then 30
// days) only ever stopped a genuine payment being recorded, leaving it paid
// for and locked (reviews 2026-10-06, DB-04, and 2026-10-08).

/**
 * { from, item }        build the payment for a store item, priced here
 * { from, item, confirm: <signature> }  record it, once it is on chain
 * { from, amount }      the old form, from builds before the purchase record
 *
 * A purchase is a record since 2026-09-30: the price is the server's (the
 * client named its own amount before), the payment carries a memo naming the
 * item, and once it lands the app asks for it to be confirmed. That reads the
 * transaction back from the chain and checks it paid exactly that item's
 * price from this wallet to the revenue wallet, then writes one row per
 * transaction (its signature is the key, so it can never count twice). The
 * rooms let a player bring only weapons with a row (api/match/status.ts).
 */
export const POST = endpoint(async (body, req) => {
  const from = parsePubkey(body.from);
  requireOutsideWallet(from);
  const item = typeof body.item === "string" ? body.item : null;
  // An item, always: the old form that named its own amount (builds before
  // the purchase record, long since required to update) let a payment of a
  // single base unit be sponsored over and over (security review, 2026-10-13).
  if (item === null || !(STORE_PRICES[item] > 0)) throw new HttpError(400, "That isn't for sale");
  if (typeof body.confirm === "string") return confirmPurchase(from, item, body.confirm, req!);
  const amount = STORE_PRICES[item];
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, "Nothing to pay");
  const units = BigInt(Math.round(amount * 10 ** USDC_DECIMALS));
  if (units <= 0n) throw new HttpError(400, "Nothing to pay");
  // Only the wallet itself can ask (recording a payment that already landed,
  // above, needs no proof: the chain is the proof).
  // Asks per network before the proof is checked and its one-time number
  // stored (security review, round two).
  if (!await withinLimit(`store:ask:ip:${ipKey(req!)}`, 300, 3600)) throw new HttpError(429, "Too many purchases — try again later.");
  await requireWalletProof(body, from, "buy", buyDetail(item, body.amount));
  // Paid for already (on another phone, say): nothing is built or charged,
  // and the game unlocks it (review 2026-10-07).
  if (item) {
    const have = await dbSelect<{ signature: string }>(`purchases?wallet=eq.${from.toBase58()}&item=eq.${encodeURIComponent(item)}&select=signature&limit=1`);
    // Unknown is not "not owned": nothing is charged until it can be asked
    // (review 2026-10-07). A payment could not be recorded meanwhile anyway.
    if (!have) throw new HttpError(503, "The store is busy. Try again in a moment.");
    if (have.length) return { owned: true };
  }

  // Per wallet, per network and overall: the platform pays each payment's fee.
  if (
    !await withinLimit(`store:w:${from.toBase58()}`, 30, 3600) ||
    !await withinLimit(`store:ip:${ipKey(req!)}`, 120, 3600)
  ) {
    throw new HttpError(429, "Too many purchases — try again later.");
  }

  const conn = connection();
  const m = mint();
  const auth = authority();
  await requireFeeFunds(conn, auth.publicKey);
  const treasury = (await program().account.config.fetch(configPda())).feeWallet;

  const source = ata(from);
  // Still this wallet's account: one whose owner was changed fails on chain
  // after the platform has paid the fee (security review, 2026-10-13).
  const src = await getAccount(conn, source).catch(() => null);
  if (src && (!src.owner.equals(from) || src.isFrozen)) throw new HttpError(400, "This wallet's USDC account can't pay right now.");
  const held = src?.amount ?? 0n;
  if (held < units) {
    throw new HttpError(
      400,
      `Only ${(Number(held) / 10 ** USDC_DECIMALS).toFixed(2)} USDC in this wallet — claim more from the faucet first`,
    );
  }

  // The overall count last, once the payment can go through: counted first,
  // requests from empty wallets used it up for everyone (security review,
  // 2026-10-14).
  if (!await withinSharedLimit("store:all", 2000, 3600)) throw new HttpError(429, "Too many purchases — try again later.");
  const destination = ata(treasury);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: auth.publicKey, blockhash, lastValidBlockHeight })
    .add(createAssociatedTokenAccountIdempotentInstruction(auth.publicKey, destination, treasury, m, TOKEN_PROGRAM_ID))
    .add(createTransferCheckedInstruction(source, m, destination, from, units, USDC_DECIMALS, [], TOKEN_PROGRAM_ID));
  if (item) tx.add(new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM, data: Buffer.from(purchaseMemo(item), "utf8") }));
  tx.partialSign(auth);
  return {
    tx: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    blockhash,
    lastValidBlockHeight,
  };
});

/** Read the payment back from the chain and, if it paid for this item, record it. */
async function confirmPurchase(from: PublicKey, item: string, signature: string, req: Request) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) throw new HttpError(400, "bad signature");
  // Recorded already: the same answer, without asking the chain again.
  const known = await dbSelect<{ wallet: string; item: string }>(`purchases?signature=eq.${signature}&select=wallet,item&limit=1`);
  if (known?.[0]?.wallet === from.toBase58() && known[0].item === item) return { ok: true, item };
  // Anyone can ask for a public signature to be read, so the reading is
  // counted per network and overall before the chain is asked (review
  // 2026-10-07). The app asks a handful of times per purchase.
  if (!(await withinLimit(`confirm:ip:${ipKey(req)}`, 120, 3600)) || !(await withinLimit("confirm:all", 6000, 3600))) {
    throw new HttpError(429, "Too many requests. Try again in a minute.");
  }
  const conn = connection();
  const tx = await conn.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx) throw new HttpError(404, "That payment isn't on chain yet. Try again in a moment.");
  if (tx.meta?.err) throw new HttpError(400, "That payment failed");
  const treasury = (await program().account.config.fetch(configPda())).feeWallet;
  // Today's treasury, or one it replaced: a payment made before the change
  // is still the player's (review 2026-10-07).
  const treasuries = new Set([treasury.toBase58(), ...PAST_STORE_TREASURIES].map((t) => ata(new PublicKey(t)).toBase58()));
  const units = String(BigInt(Math.round(STORE_PRICES[item] * 10 ** USDC_DECIMALS)));
  const ixs = tx.transaction.message.instructions as { program?: string; programId: PublicKey; parsed?: unknown }[];
  const memo = ixs.some((i) => i.programId.equals(MEMO_PROGRAM) && i.parsed === purchaseMemo(item));
  const paid = ixs.some((i) => {
    const p = i.parsed as { type?: string; info?: Record<string, unknown> } | undefined;
    if (!p || p.type !== "transferChecked" || !p.info) return false;
    const info = p.info as { source?: string; destination?: string; mint?: string; authority?: string; tokenAmount?: { amount?: string } };
    return (
      info.source === ata(from).toBase58() &&
      !!info.destination && treasuries.has(info.destination) &&
      info.mint === mint().toBase58() &&
      info.authority === from.toBase58() &&
      info.tokenAmount?.amount === units
    );
  });
  if (!memo || !paid) throw new HttpError(400, "That payment doesn't match the item");
  const r = await dbInsertNew("purchases", { signature, wallet: from.toBase58(), item, amount: STORE_PRICES[item] });
  if (r === "error") throw new HttpError(502, "Could not record the purchase. Try again in a moment.");
  return { ok: true, item };
}

/** The Android app asks before it posts; see preflight in _lib. */
export const OPTIONS = preflight;
