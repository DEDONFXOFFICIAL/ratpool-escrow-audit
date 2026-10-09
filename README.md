# RatPool: escrow and payments code, for security review

This repository is a read-only extract of RatPool's private codebase. It is
published so that security reviewers and audit partners can read and test
the parts that hold, move or protect player funds. It is not the full game:
the game client, its art and the match logic of the game server are not
included. Reviewers who need them can ask for private access.

RatPool is a 2D multiplayer arena shooter. Players stake test USDC into a
pool, fight in a timed match, and the top three are paid by an escrow
program on Solana: 50/30/20 of what is left after the fee (10% in the
deployed configuration; fewer than three stakers share the same total). It
runs on devnet.

Snapshot: see `EXPORT.txt` for the source commit and date.

## What is here

| Path | What it is |
|---|---|
| `program/` | The escrow program (Anchor 1.2, Rust) and its LiteSVM test suite |
| `api/` | The site's serverless functions (Vercel): opening matches, sponsoring joins, collection, payouts, refunds, the store, transfers, the test-USDC faucet, sign-in and profile writes |
| `server/src/api.ts` | The game server's signing of its calls to the site and of finishing orders for the escrow (Cloudflare Workers) |
| `src/chain/`, `src/economy/` | The game client's on-chain code: the program interface, wallet-signed requests, and the checks every transaction passes before the player's wallet signs it |
| `supabase/` | Database schema, row-level security and rate-limit functions |
| `vercel.json` | The site's security headers and content security policy |

## How the money moves

1. **Open.** The site creates a match account and its vault, pinning the
   entry, the fee, the fee destination, the minimum players and the refund
   delay.
2. **Join.** A player seated in a room approves exactly one entry from their
   own USDC account to the match (an SPL approve; nothing moves). The
   platform co-signs as admission, only for players the game server seated.
3. **Collect and start.** When the room locks, approved stakes move into the
   vault; a match starts only with enough collected stakes.
4. **Settle.** After the match the game server signs the finishing order with
   its own Ed25519 key. The payout instruction (`settle_signed`) requires that
   signature, checked by the ed25519 precompile straight before it, over the
   program id, the match id, the match's start time on chain and up to six
   wallets. The program picks the top three stakers from it, pays them, pays
   the inviters of invited winners from on-chain invite records, and sends
   the rest of the fee to the destination pinned at creation.
5. **Refund.** If a match is not settled within its refund delay of the first
   collection, settlement is refused and anyone can return every stake in
   full (`claim_refund`); the site sweeps for these every ten minutes.

Players never pay network fees: the platform is the fee payer on every
transaction. Before the player's wallet signs, the client checks the
transaction (`src/economy/txCheck.ts`): for a join or leave, one escrow
instruction for that match and the player's own account (the approved amount
is the entry pinned in the match on chain, which the client also reads before
staking); for a send or purchase, exactly one transfer of the asked amount
to the asked destination from the player's own account; for an invite
record, only the player's own record. Requests made in a player's name
(sends, purchases, leaving a pool, the faucet) are signed by that player's
wallet with a nonce the site spends once (`src/chain/walletRequest.ts`,
`api/_lib.ts`); when the database is unreachable the site falls back to a
per-instance memory of spent nonces, so a replay is then possible against
another instance within the request's validity window.

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
- The game server's match logic, its player sign-in and its cheat detection
  are not in this extract; ask for private access to review them.
- The refund sweep runs from the game server's schedule (not included); the
  program's `claim_refund` itself needs no signer.

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
