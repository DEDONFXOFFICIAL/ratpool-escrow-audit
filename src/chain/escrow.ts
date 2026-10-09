import { PublicKey, type Connection, type Transaction } from "@solana/web3.js";
import { AnchorProvider, BN, Program } from "@anchor-lang/core";
import type { RatpoolEscrow } from "./idl/ratpool_escrow.js";
import idlJson from "./idl/ratpool_escrow.idl.js";

/**
 * The escrow program, as the client sees it.
 *
 * Shared by the browser (the player's wallet signs `join` and `leave`) and by
 * the server functions under /api (the settle authority signs everything
 * else). No environment reads here — this file must work in both places —
 * so the caller brings the connection and the signer, and the program ID
 * comes from the IDL itself, which is generated from the deployed source.
 * If the environment's VITE_ESCROW_PROGRAM_ID disagrees with it, the config
 * module says so; this file trusts the IDL.
 */

export const IDL: RatpoolEscrow = idlJson;
export const PROGRAM_ID = new PublicKey(idlJson.address);

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// Version 2 of the program (program/MIGRATION-v2.md): new seeds, so an
// account in the old layout is never read as a new one.
const CONFIG_SEED = Buffer.from("config_v2");
const MATCH_SEED = Buffer.from("match_v2");
const VAULT_SEED = Buffer.from("vault");

/** A u64 as the eight little-endian bytes the program seeds a match with. */
function u64le(id: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(id);
  return b;
}

export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID)[0];
}

export function matchPda(id: bigint): PublicKey {
  return PublicKey.findProgramAddressSync([MATCH_SEED, u64le(id)], PROGRAM_ID)[0];
}

export function vaultPda(match: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VAULT_SEED, match.toBuffer()], PROGRAM_ID)[0];
}

/** The room server's key on chain (set by the upgrade authority): every payout needs its signature. */
export function guardPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("guard")], PROGRAM_ID)[0];
}

/**
 * Is this account the escrow's own, holding data? Anyone can send lamports to
 * a program address and make "an account" appear there; only one the
 * program created counts (review 2026-10-08).
 */
export function ownedByEscrow(info: { owner: PublicKey; data: Uint8Array | Buffer } | null | undefined, minData = 9): boolean {
  return !!info && info.owner.equals(PROGRAM_ID) && info.data.length >= minData;
}

/** Who invited `player`, on chain: written once, by the player (set_referrer). */
export function referralPda(player: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("referral"), player.toBuffer()], PROGRAM_ID)[0];
}

/** The BN the IDL wants for a u64 argument. */
export function toBn(n: bigint): BN {
  return new BN(n.toString());
}

/**
 * What a signer has to be. The wallet adapter's `useAnchorWallet()` returns
 * the first three in the browser; on the server it is a Keypair wrapped in
 * `Wallet` from the same package.
 *
 * `sendTransaction` is the browser wallet's own send, and it is the one that
 * matters: it is the only path that tells the wallet which cluster the
 * transaction is for. The adapter derives `solana:devnet` from the
 * connection's endpoint and passes it along; a bare `signTransaction`
 * carries no chain at all, so a wallet left on mainnet previews a devnet
 * transaction against mainnet and reports it reverting. Optional because
 * the server's Keypair wallet has nothing of the kind and needs nothing.
 */
export interface Signer {
  publicKey: PublicKey;
  signTransaction: AnchorProvider["wallet"]["signTransaction"];
  signAllTransactions: AnchorProvider["wallet"]["signAllTransactions"];
  sendTransaction?: (transaction: Transaction, connection: Connection) => Promise<string>;
}

export type EscrowProgram = Program<RatpoolEscrow>;

export function escrowProgram(connection: Connection, wallet: Signer): EscrowProgram {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  return new Program<RatpoolEscrow>(IDL, provider);
}

/** The on-chain Match, as the client decodes it. */
export type MatchAccount = Awaited<ReturnType<EscrowProgram["account"]["match"]["fetch"]>>;
export type ConfigAccount = Awaited<ReturnType<EscrowProgram["account"]["config"]["fetch"]>>;

/**
 * The player statuses as the IDL spells them — Anchor decodes a Rust enum to
 * an object with one lower-camel key, `{ collected: {} }`.
 */
export type PlayerStatus = "joined" | "collected" | "dropped" | "paid" | "refunded";
export type MatchState = "open" | "collected" | "settled" | "cancelled";

export function enumKey<T extends string>(v: object): T {
  return Object.keys(v)[0] as T;
}

/** Stakers whose entry is actually in the vault, in seat order. */
export function collectedPlayers(m: MatchAccount): PublicKey[] {
  return m.players
    .filter((p) => enumKey<PlayerStatus>(p.status) === "collected")
    .map((p) => p.key);
}
