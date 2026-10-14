import { Ed25519Program, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  enumKey,
  guardPda,
  ownedByEscrow,
  PROGRAM_ID,
  referralPda,
  toBn,
  TOKEN_PROGRAM_ID,
  type EscrowProgram,
  type MatchAccount,
} from "../src/chain/escrow.js";
import { ata, authority, HttpError, mint, onlySol, ROOM_KEY, signedBytesByRoom } from "./_lib.js";
import { withinLimit } from "./_db.js";

/** Mirrors the program: podium shares in percent, best first. */
const PODIUM_SHARES = [50n, 30n, 20n];
const BPS = 10_000n;
/** Mirrors the program's REFERRAL_BPS: 1% of the pool, out of the fee. */
const REFERRAL_BPS = 100n;
/** What a signed ranking starts with (program/.../constants.rs SETTLE_DOMAIN). */
const SETTLE_DOMAIN = Buffer.from("ratpool-settle-v1");
/** The program takes at most this many ranked wallets (MAX_SIGNED_RANKING). */
const SIGNED_RANKING = 6;

/** What a payout paid, as the program computed it. */
export interface Payout {
  signature: string;
  pool: bigint;
  fee: bigint;
  winners: string[];
  amounts: bigint[];
  referred: { friend: string; referrer: string; amount: bigint }[];
}

/**
 * Pay a match the way the escrow requires since the room server's key went
 * on chain (settle_signed, T02 step 3): the room's signed ranking, checked
 * here first and then by the program, which picks the podium itself; every
 * winner's invite record, as the program reads it; every payment into an
 * account its owner can use.
 *
 * `signed` is what the room server sent: base64 message and signature
 * (server/src/api.ts signSettlement). The podium is computed here the same
 * way the program computes it, only to put the right accounts in the right
 * order; the program refuses any other.
 */
export async function paySigned(p: EscrowProgram, id: bigint, m: MatchAccount, signed: unknown): Promise<Payout> {
  const s = signed as { message?: unknown; signature?: unknown } | null | undefined;
  if (!s || typeof s.message !== "string" || typeof s.signature !== "string") {
    throw new HttpError(503, "the room's signed ranking is missing");
  }
  const msg = Buffer.from(s.message, "base64");
  const sig = Buffer.from(s.signature, "base64");
  if (!signedBytesByRoom(msg, sig)) throw new HttpError(403, "the ranking is not signed by the room server");

  const d0 = SETTLE_DOMAIN.length;
  const head = d0 + 32 + 8 + 8 + 1;
  if (msg.length < head || !msg.subarray(0, d0).equals(SETTLE_DOMAIN)) throw new HttpError(400, "not a signed ranking");
  if (!new PublicKey(msg.subarray(d0, d0 + 32)).equals(PROGRAM_ID)) throw new HttpError(400, "signed for another program");
  if (msg.readBigUInt64LE(d0 + 32) !== id) throw new HttpError(400, "signed for another match");
  // Signed for another start of this id: the room asks again, and the
  // deadline refunds the stakes if it never matches.
  if (msg.readBigInt64LE(d0 + 40) !== BigInt(m.collectedAt.toString())) {
    throw new HttpError(409, "signed for another start of this match");
  }
  const count = msg[d0 + 48];
  if (count < 1 || count > SIGNED_RANKING || msg.length !== head + 32 * count) throw new HttpError(400, "malformed signed ranking");
  const ranking = Array.from({ length: count }, (_, i) => new PublicKey(msg.subarray(head + 32 * i, head + 32 * (i + 1))));

  // The podium, as the program picks it: the first stakers in the ranking.
  const collected = m.players.filter((pl) => enumKey(pl.status) === "collected").map((pl) => pl.key);
  const n = Math.min(PODIUM_SHARES.length, collected.length);
  const winners: PublicKey[] = [];
  for (const k of ranking) {
    if (winners.length === n) break;
    if (collected.some((c) => c.equals(k)) && !winners.some((w) => w.equals(k))) winners.push(k);
  }
  if (winners.length < n) throw new HttpError(409, "the signed ranking holds too few stakers");

  const conn = p.provider.connection;
  const auth = authority();

  // Every winner's invite record: the program pays each one that exists.
  const slots = winners.map(referralPda);
  const recInfos = await conn.getMultipleAccountsInfo(slots, "confirmed");
  const records: { friend: PublicKey; referrer: PublicKey }[] = [];
  recInfos.forEach((info, i) => {
    if (info && ownedByEscrow(info, 8 + 32 + 1)) {
      const r = p.coder.accounts.decode("referral", info.data) as { referrer: PublicKey };
      records.push({ friend: winners[i], referrer: r.referrer });
    }
  });

  // Where each payment lands: the owner's usual account, and no other
  // (escrow v4), reopened, the platform paying, if it was closed. A usual
  // account its owner has handed to someone else is still paid: that was
  // their own doing. A second account made for them when the usual one could
  // not take USDC put money where the app does not show it (security review,
  // 2026-10-14).
  const creates: TransactionInstruction[] = [];
  const destination = async (owner: PublicKey): Promise<PublicKey> => {
    // Off-curve owners allowed: a referrer can be any address the program
    // accepted, a program address included, and refusing to derive its
    // account failed every attempt to pay the whole match (review,
    // 2026-10-12). For a wallet it is the same account as ata().
    const usual = getAssociatedTokenAddressSync(mint(), owner, true, TOKEN_PROGRAM_ID);
    const info = await conn.getAccountInfo(usual, "confirmed");
    if (!info || onlySol(info)) creates.push(createAssociatedTokenAccountIdempotentInstruction(auth.publicKey, usual, owner, mint(), TOKEN_PROGRAM_ID));
    return usual;
  };
  const payTo: PublicKey[] = [];
  for (const w of winners) payTo.push(await destination(w));
  const referTo: PublicKey[] = [];
  for (const r of records) referTo.push(await destination(r.referrer));
  // The fee wallet's account, pinned in the match.
  creates.push(createAssociatedTokenAccountIdempotentInstruction(auth.publicKey, ata(m.feeWallet), m.feeWallet, mint(), TOKEN_PROGRAM_ID));
  // Accounts this payout makes at the platform's expense: an honest payout
  // makes each at most once, so attempts that have to make some are counted
  // per match (security review, 2026-10-14). Past three, the match waits for
  // its refund deadline instead.
  if (creates.length > 1 && !(await withinLimit(`settle:make:${id}`, 3, 86400))) {
    throw new HttpError(503, "This payout keeps needing new accounts; it waits for the refund.");
  }
  // Made first, in their own transactions: with them the payout would not
  // fit one.
  if (creates.length) await p.provider.sendAndConfirm!(new Transaction().add(...creates));

  // The room's signature, checked by the precompile straight before the payout.
  const check = Ed25519Program.createInstructionWithPublicKey({ publicKey: ROOM_KEY.toBytes(), message: msg, signature: sig });
  const signature = await p.methods
    .settleSigned(toBn(id))
    .accountsPartial({
      guard: guardPda(),
      mint: mint(),
      feeAta: ata(m.feeWallet),
      authority: auth.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .remainingAccounts([
      ...payTo.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
      ...slots.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
      ...referTo.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ])
    .preInstructions([check])
    .rpc();

  // What moved, computed as the program computes it.
  const pool = BigInt(m.pool.toString());
  const fee = (pool * BigInt(m.feeBps)) / BPS;
  const net = pool - fee;
  const k = BigInt(records.length);
  const referralTotal = k > 0n ? [(pool * REFERRAL_BPS) / BPS, fee].reduce((a, b) => (a < b ? a : b)) : 0n;
  const each = k > 0n ? referralTotal / k : 0n;
  const total = PODIUM_SHARES.slice(0, winners.length).reduce((a, b) => a + b, 0n);
  const amounts: bigint[] = new Array(winners.length).fill(0n);
  let belowFirst = 0n;
  for (let i = 1; i < winners.length; i++) {
    amounts[i] = (net * PODIUM_SHARES[i]) / total;
    belowFirst += amounts[i];
  }
  amounts[0] = net - belowFirst;
  return {
    signature,
    pool,
    fee,
    winners: winners.map((w) => w.toBase58()),
    amounts,
    referred: records.map((r) => ({ friend: r.friend.toBase58(), referrer: r.referrer.toBase58(), amount: each })),
  };
}
