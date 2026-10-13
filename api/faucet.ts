import { getAccount, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { withinLimit, withinSharedLimit } from "./_db.js";
import { requireFeeFunds, preflight, ata, authority, connection, endpoint, faucetAuthority, HttpError, ipKey, mint, parsePubkey, requireWalletProof, USDC_DECIMALS } from "./_lib.js";
import { FAUCET_DETAIL } from "../src/chain/walletRequest.js";

/** What one claim is worth, in USDC. Round 16: "let's say $2". */
const CLAIM = 2;
/** A wallet still holding this much is not given more. */
const REFILL_BELOW = 2;

/**
 * POST /api/faucet  { wallet, proof }  →  { signature, balance }
 *
 * Test USDC for testers, inside the app. Claim limits keep repeated requests
 * from draining the platform. A wallet with two or more still gets nothing.
 * Only devnet may mint; an unset cluster allows local development.
 */
/** Devnet confirmations can crawl; a function cut off mid-transaction is the worst outcome. */
export const maxDuration = 60;

export const POST = endpoint(async (body, req) => {
  const clusters = [process.env.VITE_SOLANA_CLUSTER, process.env.SOLANA_CLUSTER];
  if (clusters.some((cluster) => cluster !== undefined && cluster !== "devnet")) {
    throw new HttpError(403, "The faucet is for the test network only.");
  }
  const wallet = parsePubkey(body.wallet);
  const key = wallet.toBase58();
  // Asks per network, before the signature is checked and its one-time
  // number stored, and before the chain is read: a refused ask used to cost
  // both, unlimited (security review, 2026-10-13).
  if (!await withinLimit(`faucet:ask:ip:${ipKey(req!)}`, 120, 3600)) throw new HttpError(429, "Too many claims — try again later.");
  // Only the wallet itself can claim: naming someone else's spent their claims.
  await requireWalletProof(body, wallet, "faucet", FAUCET_DETAIL);
  // Whether the wallet needs a refill, read before any allowance is counted:
  // naming a full wallet used to spend its claims and the network's for
  // nothing (review 2026-10-06).
  const before = await getAccount(connection(), ata(wallet)).catch(() => null);
  if (before && Number(before.amount) / 10 ** USDC_DECIMALS >= REFILL_BELOW) {
    throw new HttpError(429, `You still have ${(Number(before.amount) / 10 ** USDC_DECIMALS).toFixed(2)} test USDC — stake some first`);
  }
  if (
    !await withinLimit(`faucet:w:${key}`, 1, 600)
    || !await withinLimit(`faucet:wd:${key}`, 6, 86400)
    || !await withinLimit(`faucet:ip:${ipKey(req!)}`, 10, 3600)
    || !await withinSharedLimit("faucet:all", 400, 86400)
  ) {
    throw new HttpError(429, "Too many claims — try again later.");
  }
  const conn = connection();
  await requireFeeFunds(conn, authority().publicKey);
  const m = mint();

  // The authority pays the rent for a first-time token account; the faucet
  // key only mints.
  const account = await getOrCreateAssociatedTokenAccount(conn, authority(), m, wallet);
  const held = Number(account.amount) / 10 ** USDC_DECIMALS;
  if (held >= REFILL_BELOW) {
    throw new HttpError(429, `You still have ${held.toFixed(2)} test USDC — stake some first`);
  }

  const units = BigInt(CLAIM * 10 ** USDC_DECIMALS);
  const signature = await mintTo(conn, authority(), m, account.address, faucetAuthority(), units);
  return { signature, balance: held + CLAIM };
});

/** The Android app asks before it posts; see preflight in _lib. */
export const OPTIONS = preflight;
