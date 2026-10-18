import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Wallet } from "@anchor-lang/core";
import { escrowProgram, TOKEN_PROGRAM_ID, type EscrowProgram } from "../src/chain/escrow.js";
import { PRICE_TIERS, type PriceTier } from "../src/state/types.js";
import { withinLimit } from "./_db.js";
import { readWalletRequest, type WalletAction } from "../src/chain/walletRequest.js";
import { clientIp } from "./_ip.js";

/**
 * What every function under /api shares: the keys, the connection, the
 * program, and the shape of a reply.
 *
 * This is the settle authority. It is one key on devnet, held in the
 * function's environment and nowhere else (see docs/ESCROW.md §12 and
 * Round 16). What it can do is bounded by the program, not by this code:
 * open a room, collect approved stakes (and so decide which are in the
 * match), start, cancel, reclaim rent. It cannot pay anyone who did not
 * stake, and it cannot move the fee anywhere but the wallet pinned in the
 * match.
 *
 * Nor can it alter the finishing order: every payout needs the room
 * server's signature over it, checked by the program itself (escrow v3,
 * api/_settle.ts).
 */

export const USDC_DECIMALS = 6;

function keypairFromEnv(name: string): Keypair {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is not set`);
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed) as number[]));
  }
  // base58, as `solana-keygen` and most wallets export it
  return Keypair.fromSecretKey(bs58decode(trimmed));
}

function bs58decode(s: string): Uint8Array {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes: number[] = [0];
  for (const ch of s) {
    let carry = A.indexOf(ch);
    if (carry < 0) throw new Error("bad base58");
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

let _authority: Keypair | null = null;
export function authority(): Keypair {
  return (_authority ??= keypairFromEnv("ESCROW_AUTHORITY_KEYPAIR"));
}

/**
 * The platform's sponsor: pays the fee on the players' own join and leave,
 * and is the program's admission signer, so no wallet takes an on-chain seat
 * the room did not give it (escrow v2, review C02). Its own key, apart from
 * the settle authority, so the key that pays winners is not also the one
 * handing out seats. Until it is configured the authority stands in.
 */
let _sponsor: Keypair | null = null;
export function sponsor(): Keypair {
  return (_sponsor ??= process.env.SPONSOR_KEYPAIR ? keypairFromEnv("SPONSOR_KEYPAIR") : authority());
}

/** How long a room's admission ticket is good for. */
export const ADMIT_MS = 5 * 60 * 1000;

/**
 * A seat the room handed out: the room server signs match, wallet and expiry
 * with its own key (server/src/room.ts admitFor), and the sponsor co-signs a
 * join only for a ticket that checks out.
 */
export function admitted(matchId: bigint, wallet: PublicKey, exp: unknown, sig: unknown): boolean {
  if (typeof exp !== "number" || typeof sig !== "string" || sig.length > 128) return false;
  if (!Number.isFinite(exp) || exp < Date.now() || exp > Date.now() + ADMIT_MS + 60_000) return false;
  return signedByRoom(`admit\n${matchId}\n${wallet.toBase58()}\n${exp}`, sig);
}

let _faucet: Keypair | null = null;
export function faucetAuthority(): Keypair {
  return (_faucet ??= keypairFromEnv("FAUCET_MINT_AUTHORITY_KEYPAIR"));
}

/**
 * A wallet a caller names as the one that pays, sends or stakes must never be
 * one of the server's own. The sponsored functions co-sign with the authority,
 * so a request naming the authority as its sender came back with every
 * signature it needed: the authority's own tokens, moved wherever the caller
 * said, by anyone (found 2026-09-29, never used).
 */
export function requireOutsideWallet(key: PublicKey): void {
  const own = [authority().publicKey, sponsor().publicKey];
  if (process.env.FAUCET_MINT_AUTHORITY_KEYPAIR) own.push(faucetAuthority().publicKey);
  if (own.some((k) => k.equals(key))) throw new HttpError(400, "That wallet cannot be used here");
}

export function connection(): Connection {
  return new Connection(process.env.SOLANA_RPC || "https://api.devnet.solana.com", "confirmed");
}

/**
 * Opening a match pays its account's and its vault's rent (about 0.03 SOL),
 * which comes back when the match closes. Checked on top of the usual floor,
 * so an opening never leaves the platform below it (security review,
 * 2026-10-13).
 */
export const MATCH_RENT_LAMPORTS = 30_000_000;
/**
 * The cleanup (cancelling, refunding, closing) pays only its fees and gives
 * rent back, so it runs on far less than the usual floor: under the floor it
 * used to stop, and with it the rent that would have refilled the platform.
 */
export const RECOVERY_FLOOR_LAMPORTS = 3_000_000;

/**
 * Nothing but SOL at a token account's address: anyone can send SOL to an
 * address before its account is made. The account program makes the account
 * over it all the same, so it counts as missing: read as "there, but not a
 * token account", it sent payouts to a spare account and refused transfers
 * (security review, 2026-10-13).
 */
export function onlySol(info: { owner: PublicKey; data: { length: number } } | null): boolean {
  return !!info && info.owner.equals(SystemProgram.programId) && info.data.length === 0;
}

/** Reject unfunded actions before building or signing a transaction. */
export async function requireFeeFunds(conn: Connection, payer: PublicKey, lamports = 10_000_000): Promise<number> {
  const balance = await conn.getBalance(payer);
  if (balance < lamports) {
    console.error("[api] insufficient fee funds", { payer: payer.toBase58(), balance, required: lamports });
    throw new HttpError(503, "Can't do that right now. Try again in a minute.");
  }
  return balance;
}

export function mint(): PublicKey {
  const m = process.env.USDC_MINT || process.env.VITE_USDC_MINT;
  if (!m) throw new Error("USDC_MINT is not set");
  return new PublicKey(m);
}

export function program(): EscrowProgram {
  return escrowProgram(connection(), new Wallet(authority()));
}

export function ata(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint(), owner, false, TOKEN_PROGRAM_ID);
}

export function tierById(id: unknown): PriceTier | null {
  return PRICE_TIERS.find((t) => t.id === id) ?? null;
}

export function entryUnits(tier: PriceTier): bigint {
  return BigInt(Math.round(tier.entry * 10 ** USDC_DECIMALS));
}

/** A match id that is unique enough and sorts by time: ms since epoch × 1000 + noise. */
export function newMatchId(): bigint {
  return BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
}

export function parseId(v: unknown): bigint {
  if (typeof v !== "string" || !/^\d{1,20}$/.test(v)) throw new HttpError(400, "bad match id");
  return BigInt(v);
}

export function parsePubkey(v: unknown): PublicKey {
  try {
    if (typeof v !== "string") throw 0;
    return new PublicKey(v);
  } catch {
    throw new HttpError(400, "bad public key");
  }
}

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/**
 * The room server's public key (Ed25519, raw, hex): it checks the room's
 * signed calls and tickets. The private half is held by Cloudflare alone
 * (server/src/api.ts ROOM_SIGNING_KEY), so nothing this site holds can sign
 * as the room (review 2026-10-07, T02). The secret the two used to share is
 * retired: a leak of the site's settings can no longer forge a ranking.
 */
const ROOM_PUBLIC_KEY = "8fd28d71134e9a0bb806ff438b9fb63ae0d65ccf4f9a18f73c19e23a471be0e6";
/** The room server's public key, as the escrow's guard holds it (settle_signed). */
export const ROOM_KEY = new PublicKey(Buffer.from(ROOM_PUBLIC_KEY, "hex"));
let roomKey: ReturnType<typeof createPublicKey> | null = null;

/** Did the room server sign exactly these bytes with its own key? */
export function signedBytesByRoom(bytes: Buffer, signature: Buffer): boolean {
  roomKey ??= createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(ROOM_PUBLIC_KEY, "hex")]), format: "der", type: "spki" });
  return signature.length === 64 && verify(null, bytes, roomKey, signature);
}

/** Did the room server sign exactly this text with its own key? */
function signedByRoom(text: string, signatureB64: string): boolean {
  return signedBytesByRoom(Buffer.from(text, "utf8"), Buffer.from(signatureB64, "base64"));
}

/** Did this wallet sign exactly this text? (A message signature: no transaction, no fee.) */
export function signedBy(wallet: PublicKey, message: string, signatureB64: string): boolean {
  const key = createPublicKey({
    key: Buffer.concat([SPKI_ED25519, Buffer.from(wallet.toBytes())]),
    format: "der",
    type: "spki",
  });
  return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureB64, "base64"));
}

/**
 * A phone clock set by hand can be hours out; refusing it would stop that
 * phone sending at all. The nonce, not the clock, is what makes a request
 * good once; the window only bounds how long nonces are kept.
 */
const REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The wallet a request names must have signed it (src/chain/walletRequest.ts).
 * Checked before anything is prepared or any allowance counted, so a request
 * in another player's name is refused outright instead of spending their
 * limits (review 2026-10-06). Each signed request is good once.
 */
export async function requireWalletProof(body: Record<string, unknown>, wallet: PublicKey, action: WalletAction, detail: string): Promise<void> {
  const proof = body.proof as { message?: unknown; signature?: unknown } | undefined;
  if (!proof || typeof proof.message !== "string" || typeof proof.signature !== "string" || proof.message.length > 1024) {
    throw new HttpError(426, "Update RatPool to continue.");
  }
  const r = readWalletRequest(proof.message);
  if (!r || r.wallet !== wallet.toBase58() || r.action !== action || r.detail !== detail) {
    throw new HttpError(401, "This request was not made by this wallet.");
  }
  const issued = Date.parse(r.issued);
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > REQUEST_WINDOW_MS) {
    throw new HttpError(401, "This request has expired. Try again.");
  }
  if (!signedBy(wallet, proof.message, proof.signature)) throw new HttpError(401, "This request was not made by this wallet.");
  if (!(await withinLimit(`proof:${r.nonce}`, 1, Math.ceil((2 * REQUEST_WINDOW_MS) / 1000)))) {
    throw new HttpError(409, "That request was already used. Try again.");
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** How far a signed request's time may be from ours: clock drift and a slow hop, no more. */
const SIGNATURE_WINDOW_MS = 120_000;

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Cross-origin callers allowed to use these functions: the Android app.
 *
 * The app bundles the game and serves it from `https://app.ratpool.xyz` inside
 * its own web view (capacitor.config.ts), so its calls to
 * https://www.ratpool.xyz/api are cross-origin and the browser engine asks
 * first. The website itself is same-origin and never needs this. Nothing else
 * is let in: these functions pay fees, and an open `*` would let any site
 * spend the platform's SOL on a visitor's behalf. (`https://localhost` was the
 * app's first origin; kept until every installed copy has updated.)
 */
// The Android app's page (capacitor.config.ts, every build since 20; the
// minimum is far past it). https://localhost was an older app's and is gone
// (outside report, 2026-10-18).
const APP_ORIGINS = new Set(["https://app.ratpool.xyz"]);


export { clientIp };

export function ipKey(req: Request): string {
  // Counters need a stable key, not a stored address.
  return createHash("sha256").update(clientIp(req)).digest("hex").slice(0, 32);
}

function withCors(req: Request, res: Response): Response {
  const origin = req.headers.get("origin");
  if (origin && APP_ORIGINS.has(origin)) {
    res.headers.set("access-control-allow-origin", origin);
    res.headers.set("vary", "origin");
  }
  return res;
}

/** The browser's "may I?" before a cross-origin POST. Export as OPTIONS. */
export function preflight(req: Request): Response {
  const res = new Response(null, { status: 204 });
  const origin = req.headers.get("origin");
  if (origin && APP_ORIGINS.has(origin)) {
    res.headers.set("access-control-allow-origin", origin);
    res.headers.set("access-control-allow-methods", "POST, OPTIONS");
    res.headers.set("access-control-allow-headers", "content-type");
    res.headers.set("access-control-max-age", "86400");
    res.headers.set("vary", "origin");
  }
  return res;
}

/**
 * Wrap a handler: JSON in, JSON out, errors as { error }. Exported under the
 * method name — `export const POST = endpoint(...)` — because that is how
 * Vercel recognises a Web-standard handler; a default export is taken for
 * the older (req, res) style and its returned Response is dropped. Unexpected
 * errors stay in the logs; a reference lets us find them for a player.
 */
/** The largest request body any function reads. */
const MAX_BODY = 256 * 1024;

export function endpoint(
  fn: (body: Record<string, unknown>, req?: Request) => Promise<unknown>,
  opts: { signed?: boolean } = {},
): (req: Request) => Promise<Response> {
  // Every answer, errors included, carries the app's CORS header, or the app
  // sees a network failure instead of the reason.
  return async (req: Request) => withCors(req, await handle(req));
  async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    // Nothing honest is near this (an account save is at most 64 KB): a
    // bigger body is refused before it is read in full or parsed.
    if (Number(req.headers.get("content-length")) > MAX_BODY) return json({ error: "body too large" }, 413);
    let body: Record<string, unknown> = {};
    let text = "";
    try {
      text = await req.text();
      if (text.length > MAX_BODY) return json({ error: "body too large" }, 413);
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      return json({ error: "body must be JSON" }, 400);
    }
    // The room server's functions: only a body the room server signed with
    // its own key, a moment ago, gets in. A ranking a browser made up is
    // refused here, which is the trust the game server exists to remove.
    if (opts.signed) {
      // The time is signed with the body, so a signed request copied off
      // the wire is worthless a couple of minutes later.
      const ts = Number(req.headers.get("x-room-ts"));
      if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SIGNATURE_WINDOW_MS) {
        return json({ error: "only the room server may call this" }, 403);
      }
      // The function's path is signed too, so a signed request for one
      // function (a status read) cannot be replayed at another (a
      // collection) that takes the same body. See server/src/api.ts.
      // A one-time nonce, spent below, so a copy replayed inside the window
      // is refused (R15). Version 5 is the room's own key; version 4, the
      // shared secret, is retired (2026-10-07).
      const nonce = req.headers.get("x-room-nonce") ?? "";
      if (req.headers.get("x-room-sig-v") !== "5" || !/^[0-9a-f]{32}$/.test(nonce)) {
        return json({ error: "only the room server may call this" }, 403);
      }
      const given = req.headers.get("x-room-signature") ?? "";
      const path = new URL(req.url).pathname;
      if (given.length > 128 || !signedByRoom(`POST ${path}\n${ts}\n${nonce}\n${text}`, given)) {
        return json({ error: "only the room server may call this" }, 403);
      }
      // Spent once, kept past the window it could be replayed in.
      if (!(await withinLimit(`nonce:${nonce}`, 1, Math.ceil((2 * SIGNATURE_WINDOW_MS) / 1000)))) {
        return json({ error: "this request was already used" }, 409);
      }
    }
    try {
      return json(await fn(body, req));
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      const msg = (e as Error)?.message ?? String(e);
      const ref = randomBytes(4).toString("hex");
      console.error(`[api] ${ref}`, msg, (e as Error)?.stack);
      return json({ error: "Something went wrong. Try again in a minute.", ref }, 500);
    }
  }
}
