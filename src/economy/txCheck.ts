import { PublicKey, type Transaction, type TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, decodeTransferCheckedInstruction } from "@solana/spl-token";
import { IDL, matchPda, PROGRAM_ID, referralPda } from "@/chain/escrow";

/**
 * What the wallet is about to sign, checked against what the player asked
 * for, before it signs (review R10).
 *
 * The server builds every one of the player's transactions and the
 * embedded wallet signs without a prompt — the platform must not feel like
 * web3 — so the check the player never sees is done here instead: the one
 * program and action expected, the player's own account, the exact amount,
 * and nothing else in the transaction. A server that was tampered with can
 * no longer have a player sign away more than the tap they made.
 */
export class TxRefused extends Error {
  constructor(why: string) {
    super("Something didn't look right, so nothing was signed. Try again.");
    console.warn("[tx] refused:", why);
  }
}

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

function notPaidBy(tx: Transaction, owner: PublicKey) {
  if (!tx.feePayer || tx.feePayer.equals(owner)) throw new TxRefused("the player would pay the fee");
}

/** The player's join or leave: one escrow instruction, this match, this player. */
export function checkEscrowTx(
  tx: Transaction,
  want: { action: "join" | "leave"; id: bigint; owner: PublicKey; ownerAta: PublicKey },
): void {
  notPaidBy(tx, want.owner);
  if (tx.instructions.length !== 1) throw new TxRefused(`${tx.instructions.length} instructions`);
  const ix = tx.instructions[0];
  if (!ix.programId.equals(PROGRAM_ID)) throw new TxRefused("not the escrow program");
  // The instruction's tag from the IDL, then its one argument, the match id (u64, little endian).
  const tag = IDL.instructions.find((i) => i.name === want.action)?.discriminator;
  const data = Buffer.from(ix.data);
  if (!tag || data.length !== 16 || !data.subarray(0, 8).equals(Buffer.from(tag))) throw new TxRefused(`not a ${want.action}`);
  if (data.readBigUInt64LE(8) !== want.id) throw new TxRefused("another match");
  const has = (k: PublicKey, signer?: boolean) => ix.keys.some((a) => a.pubkey.equals(k) && (!signer || a.isSigner));
  if (!has(matchPda(want.id))) throw new TxRefused("another match account");
  if (!has(want.owner, true) || !has(want.ownerAta)) throw new TxRefused("not the player's account");
}

/**
 * Who invited the player, recorded on chain: one escrow instruction, the
 * player's own record, this referrer, the platform paying the rent and the
 * fee. It moves no money.
 */
export function checkReferralTx(tx: Transaction, want: { owner: PublicKey; referrer: PublicKey }): void {
  notPaidBy(tx, want.owner);
  if (tx.instructions.length !== 1) throw new TxRefused(`${tx.instructions.length} instructions`);
  const ix = tx.instructions[0];
  if (!ix.programId.equals(PROGRAM_ID)) throw new TxRefused("not the escrow program");
  // The IDL at run time names it in snake case; its type, in camel case.
  const tag = IDL.instructions.find((i) => (i.name as string) === "set_referrer" || (i.name as string) === "setReferrer")?.discriminator;
  const data = Buffer.from(ix.data);
  if (!tag || data.length !== 40 || !data.subarray(0, 8).equals(Buffer.from(tag))) throw new TxRefused("not an invite record");
  if (!new PublicKey(data.subarray(8, 40)).equals(want.referrer)) throw new TxRefused("another referrer");
  // referral, player (signer), payer (signer, not the player), system program
  if (!ix.keys[0]?.pubkey.equals(referralPda(want.owner))) throw new TxRefused("another player's record");
  if (!ix.keys[1]?.pubkey.equals(want.owner) || !ix.keys[1].isSigner) throw new TxRefused("not the player");
  if (!ix.keys[2] || ix.keys[2].pubkey.equals(want.owner)) throw new TxRefused("the player would pay the rent");
}

/**
 * USDC out of the player's own account: one checked transfer of exactly the
 * amount to exactly the destination, plus at most the platform creating the
 * destination account (it pays) and the store's receipt memo.
 */
export function checkTransferTx(
  tx: Transaction,
  want: { owner: PublicKey; source: PublicKey; destination: PublicKey; mint: PublicKey; units: bigint; memo?: string },
): void {
  notPaidBy(tx, want.owner);
  let transfers = 0;
  let memos = 0;
  for (const ix of tx.instructions as TransactionInstruction[]) {
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      // Create-if-missing for the destination, paid by the platform.
      if (ix.keys[0]?.pubkey.equals(want.owner) || !ix.keys[1]?.pubkey.equals(want.destination)) {
        throw new TxRefused("an account the player would pay for");
      }
      continue;
    }
    if (ix.programId.equals(MEMO_PROGRAM)) {
      if (want.memo === undefined || Buffer.from(ix.data).toString("utf8") !== want.memo) throw new TxRefused("an unexpected memo");
      memos++;
      continue;
    }
    if (!ix.programId.equals(TOKEN_PROGRAM_ID)) throw new TxRefused("an unexpected program");
    let t: ReturnType<typeof decodeTransferCheckedInstruction>;
    try {
      t = decodeTransferCheckedInstruction(ix, TOKEN_PROGRAM_ID);
    } catch {
      throw new TxRefused("a token instruction that is not a transfer");
    }
    if (
      !t.keys.source.pubkey.equals(want.source) ||
      !t.keys.destination.pubkey.equals(want.destination) ||
      !t.keys.mint.pubkey.equals(want.mint) ||
      !t.keys.owner.pubkey.equals(want.owner) ||
      t.data.amount !== want.units
    ) {
      throw new TxRefused("a transfer that is not the one asked for");
    }
    transfers++;
  }
  if (transfers !== 1) throw new TxRefused(`${transfers} transfers`);
  // A store payment without its memo could never become a purchase record.
  if (want.memo !== undefined && memos !== 1) throw new TxRefused(`${memos} memos`);
}
