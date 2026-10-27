// Every stake RatPool's escrow owes back, returned with none of RatPool's own
// servers involved. Anyone with a little SOL can run it.
//
// A pool that took its stakes and was not paid out by its deadline (the room
// server or the site down, say), or that was cancelled, owes each staker
// their entry. The escrow's refund is open to anyone once that is so, and
// sends each entry only to the staker's own USDC account: whoever runs this
// pays the network fee and receives nothing; the players get their money.
// RatPool's site does the same by itself (api/_refund.ts); this is the way
// that does not need the site (audit/REMEDIATION.md, R12).
//
//   node scripts/refund-expired.mjs --payer my-wallet.json             return every stake owed (devnet)
//   node scripts/refund-expired.mjs --dry                              list what is owed, send nothing
//   node scripts/refund-expired.mjs --payer key.json --rpc <url> --program <id>
//
// It reads the chain and nothing else: the escrow's public interface
// (src/chain/idl/ratpool_escrow.json), its match accounts and the chain's
// clock. Nothing is sent to RatPool.

import fs from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const idl = JSON.parse(fs.readFileSync(new URL("../src/chain/idl/ratpool_escrow.json", import.meta.url), "utf8"));
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const RPC = arg("--rpc") || process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const PROGRAM = new PublicKey(arg("--program") || idl.address);
const DRY = process.argv.includes("--dry");
const payerPath = arg("--payer");
const payer = payerPath ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(payerPath, "utf8")))) : null;

const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0];
const CONFIG = pda(Buffer.from("config_v2"));
const MATCH_DISC = Buffer.from(idl.accounts.find((a) => a.name === "Match").discriminator);
const CLAIM_DISC = Buffer.from(idl.instructions.find((i) => i.name === "claim_refund").discriminator);
const STATE = ["Open", "Collected", "Settled", "Cancelled"];
const STATUS = ["Joined", "Collected", "Dropped", "Paid", "Refunded"];

/** The Match account (program/programs/ratpool-escrow/src/state.rs), read field by field. */
function readMatch(data) {
  let o = 8;
  const u64 = () => ((o += 8), data.readBigUInt64LE(o - 8));
  const i64 = () => ((o += 8), data.readBigInt64LE(o - 8));
  const u8 = () => data[o++];
  const key = () => ((o += 32), new PublicKey(data.subarray(o - 32, o)));
  const id = u64();
  const entry = u64();
  o += 2; // fee_bps
  key(); // fee_wallet
  u8(); // min_players
  i64(); // refund_delay
  const refundAfter = i64();
  const state = STATE[u8()];
  i64(); // collected_at
  const pool = u64();
  u8(); // bump
  const n = data.readUInt32LE(o);
  o += 4;
  const players = [];
  for (let i = 0; i < n; i++) players.push({ key: key(), tokenAccount: key(), status: STATUS[u8()] });
  return { id, entry, refundAfter, state, pool, players };
}

/** The config's mint: after the authority and the optional pending one, the admission and the fee wallet. */
function configMint(data) {
  let o = 8 + 32;
  o += data[o] === 1 ? 33 : 1;
  return new PublicKey(data.subarray(o + 64, o + 96));
}

const usdc = (units) => (Number(units) / 1e6).toFixed(2);

// Ends by setting the exit code and returning: process.exit() with the RPC's
// sockets still closing aborts Node on Windows.
async function main() {
if (!DRY && !payer) {
  console.error("Give a wallet to pay the network fees: --payer <keypair.json>   (or --dry to list only)");
  return 2;
}
const conn = new Connection(RPC, "confirmed");
const now = BigInt((await conn.getBlockTime(await conn.getSlot())) ?? Math.floor(Date.now() / 1000));
const config = await conn.getAccountInfo(CONFIG);
if (!config) {
  console.error(`No RatPool escrow at ${PROGRAM.toBase58()} on ${RPC}.`);
  return 1;
}
const mint = configMint(config.data);

const owed = [];
const seen = {};
for (const { pubkey, account } of await conn.getProgramAccounts(PROGRAM)) {
  if (!account.data.subarray(0, 8).equals(MATCH_DISC)) continue;
  const m = readMatch(account.data);
  seen[m.state] = (seen[m.state] ?? 0) + 1;
  // The program's own rule (claim_refund.rs): cancelled, or past its deadline unpaid.
  const open = m.state === "Cancelled" || ((m.state === "Open" || m.state === "Collected") && m.refundAfter !== 0n && now >= m.refundAfter);
  if (!open) continue;
  for (const p of m.players) if (p.status === "Collected") owed.push({ match: pubkey, id: m.id, entry: m.entry, player: p.key });
}

console.log(`Read ${Object.values(seen).reduce((a, b) => a + b, 0)} pool(s): ${Object.entries(seen).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ") || "none"}.`);
const total = owed.reduce((a, s) => a + s.entry, 0n);
console.log(`${owed.length} stake(s) owed back, ${usdc(total)} USDC in all, in ${new Set(owed.map((s) => s.id)).size} pool(s).`);
for (const s of owed) console.log(`  pool ${s.id}: ${usdc(s.entry)} USDC to ${s.player.toBase58()}`);
if (DRY || !owed.length) return 0;

let done = 0;
for (const s of owed) {
  const playerAta = getAssociatedTokenAddressSync(mint, s.player, false, TOKEN_PROGRAM_ID);
  const vault = pda(Buffer.from("vault"), s.match.toBuffer());
  const idLe = Buffer.alloc(8);
  idLe.writeBigUInt64LE(s.id);
  const claim = new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: CONFIG, isSigner: false, isWritable: false },
      { pubkey: s.match, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: playerAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([CLAIM_DISC, idLe, s.player.toBuffer()]),
  });
  // The player's own USDC account, made first if they closed it: the payer
  // pays its rent, and the refund cannot go anywhere else.
  const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, playerAta, s.player, mint, TOKEN_PROGRAM_ID), claim);
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    done++;
    console.log(`  returned ${usdc(s.entry)} USDC to ${s.player.toBase58()} (${sig})`);
  } catch (e) {
    console.error(`  not returned to ${s.player.toBase58()}: ${(e && e.message) || e}`);
  }
}
console.log(`${done} of ${owed.length} returned.`);
return done === owed.length ? 0 : 1;
}

process.exitCode = await main();
