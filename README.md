# RatPool: escrow and payments code, for security review

This repository is a read-only extract of RatPool's private codebase. It is
published so that security reviewers and audit partners can read and test
the parts that hold, move or protect player funds. It is not the full game:
the game client, its art and the match logic of the game server are not
included. Reviewers who need them can ask for private access.

RatPool is a 2D multiplayer arena shooter. Players stake test USDC into a
pool, fight in a timed match, and the top seven are paid by a Solana escrow.
At the configured 10% fee their gross-pot shares are 20/18/16/12/10/8/6%.
The entire commission goes to the platform. Direct referral rewards are
leaderboard points (20 paid / 5 Free Play top-seven finishes), not cash.
Current game rooms hold 25-40 paid players; the contract retains a 50-seat cap.
It runs on devnet.

Snapshot: see `EXPORT.txt` for the full source commit and date, and
`EXPORT-MANIFEST.json` for each exported file's SHA-256. The private project is
the source of truth; this repository is its curated review copy, not a separate
escrow implementation. Only committed source is exported, never local settings
or unpublished branch changes.

The v6 interface retains `join(id, expected_entry)` and uses new config/match
seeds with a pinned winner count and weights. See `program/UPGRADE-v6.md`.
The new binary passed 80 contract tests, including 25/40/50 stakers and a
seven-winner settlement fitting 1,232 bytes. Deployment receipts must establish
which binary is actually live. This is test evidence, not independent auditor
certification. Historical migrations in this extract do not establish which
migrations a hosted database has run.

## What is here

| Path | What it is |
|---|---|
| `program/` | The escrow program (Anchor 1.2, Rust) and its LiteSVM test suite |
| `api/` | The site's serverless functions (Vercel): opening matches, sponsoring joins, collection, payouts, refunds, the store, transfers, the test-USDC faucet, sign-in and profile writes |
| `server/src/api.ts` | The game server's signing of its calls to the site and of finishing orders for the escrow (Cloudflare Workers) |
| `src/chain/`, `src/economy/` | The game client's on-chain code: the program interface, wallet-signed requests, and the checks every transaction passes before the player's wallet signs it |
| `supabase/` | Database schema, row-level security and rate-limit functions |
| `scripts/refund-expired.mjs` | Returns every stake the escrow owes, reading only the chain: no RatPool server needed (below) |
| `vercel.json` | The site's security headers and content security policy |

## How the money moves

1. **Open.** The site creates a match account and its vault, pinning the
   entry, the fee, the fee destination, the minimum players and the refund
   delay.
2. **Join.** A player seated in a room signs the exact displayed entry amount.
   The contract requires it to match the pool entry before approving that
   amount from their
   own USDC account to the match (an SPL approve; nothing moves). The
   platform co-signs as admission, only for players the game server seated.
3. **Collect and start.** When the room locks, approved stakes move into the
   vault; a match starts only with enough collected stakes.
4. **Settle.** After the match the game server signs the finishing order with
   its own Ed25519 key. The payout instruction (`settle_signed`) requires that
   signature, checked by the ed25519 precompile straight before it, over the
   v6 domain, program id, match id, on-chain start time and up to twelve
   wallets (seven in the current service). The program chooses the pinned
   number of stakers, pays their usual token accounts, and sends the full
   commission to the destination pinned at creation. No referral cash moves.
5. **Refund.** If a match is not settled within its refund delay of the first
   collection, settlement is refused and anyone can return every stake in
   full (`claim_refund`); the site sweeps for these every ten minutes.

Players never pay network fees: the platform is the fee payer on every
transaction. Before the player's wallet signs, the client checks the
transaction (`src/economy/txCheck.ts`): for a join or leave, one escrow
instruction for that match and the player's own account, with the exact
expected entry amount embedded in a join; for a send or purchase, exactly one transfer of the asked amount
to the asked destination from the player's own account; for an invite
record, only the player's own record. Requests made in a player's name
(sends, purchases, leaving a pool, the faucet) are signed by that player's
wallet with a nonce the site spends once (`src/chain/walletRequest.ts`,
`api/_lib.ts`). Signed wallet and room requests require a shared database nonce
check. When it is unavailable they are refused temporarily; there is no
per-instance memory fallback for those nonces. Ordinary request limits have
separate fallback behavior in `api/_db.ts`.

## Keys and roles

| Role | Public key | Held by | Can |
|---|---|---|---|
| Program | `Ctu4Q9hJKUksKZ9mXrydtua2LcuvmM8Wt34Xc6VK1wmj` | | |
| Upgrade authority | `GgdJJkjrCP23utqrRXk1kvGLLSPFqJcSYfJCN9Jtr5kp` | offline | upgrade the program; change the config; set the game server's key; carry over invites; nominate a new payout authority |
| Payout (config) authority | `DdVBxG3cvuuuuDquwmBmzjmp8aDaARe6ojX7sUxJ8Sdu` | the site | open, collect, start, cancel, evict and settle matches. It cannot change the signed finishing order, but it decides which approved stakes are collected (an uncollected player is dropped, not charged), and so who is eligible |
| Sponsor and admission | `FFB2gy5cKq97TBdZQuAgi4NmLjrifaSDdV9r53p34doP` | the site | pay transaction fees; admit seated players |
| Game server (room key) | `AgRWqj2KNuj7mxw26o9fikXttqvmPakpFH9FWcmdbpXo` | the game server only | sign rankings and calls to the site |
| Test USDC mint | `8mK5uCzvnYmeP3zJuhHBT3BQNYheFpiqnvEm8Ybemf9G` | the platform's faucet | devnet only |

## Known limits and trust assumptions

- The match itself is played off chain. The escrow pays the podium the game
  server signs; whoever controls the game server's deployment can run code
  beside its key. A false result needs that key, not the payout key.
- The upgrade authority is a single offline key on devnet; a multisig will
  hold it before mainnet.
- The test USDC mint's authorities are the platform's (devnet only).
- Shared SOL spending reservations remain a separate draft change and are not
  active in this released snapshot. Request limits and balance checks are not
  a global reservation ledger. Independent audit and mainnet release controls
  remain outstanding.
- The game server's match logic, its player sign-in and its cheat detection
  are not in this extract; ask for private access to review them.
- The refund sweep runs from the game server's schedule (not included); the
  program's `claim_refund` itself needs no signer, and
  `scripts/refund-expired.mjs` runs it without any RatPool server.

## If RatPool's servers are down

A stake never depends on RatPool being up. Each pool pins a payout deadline
when it collects; once that passes unpaid, or the pool is cancelled, the
program's `claim_refund` is open to anyone and sends each entry only to the
staker's own USDC account. `scripts/refund-expired.mjs` does it for every pool
at once, reading nothing but the chain:

```
pnpm install
node scripts/refund-expired.mjs --dry                     # what is owed
node scripts/refund-expired.mjs --payer my-wallet.json    # return it
```

Add `--rpc <url>` for another RPC (devnet's public one is the default).
Whoever runs it pays the network fees and receives nothing. Tested on a local
validator running the deployed program, byte for byte: six stakes collected,
no payout, nothing refundable before the deadline, all six returned after it,
none twice, and nothing to the wallet that ran it (2026-10-27).

## Building and testing the program

Requires, on Linux or WSL2: Rust 1.89 (`program/rust-toolchain.toml`), the
Solana CLI (Agave 4.1 used here, with its `cargo build-sbf`) and the Anchor
CLI 1.2. The tests load the built program, so build first:

```
cd program
anchor build --arch v0     # --arch v0: LiteSVM's loader does not accept SBPF v3
cargo test -p ratpool-escrow
```

`build.sh` and `test.sh` do the same with the target directory on the Linux
side.

The TypeScript files are provided for reading; they build inside the private
repository's toolchain.

## Reporting

Report anything you find privately to the team (see `SECURITY.md`); please do
not open a public issue for a vulnerability.

## Licence

Published for security review only. All rights reserved: no licence is
granted to use, copy, modify or deploy this code. See `LICENSE`.
