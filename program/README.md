# RatPool escrow program

The on-chain half of the money. One Anchor program, `ratpool_escrow`, that
holds a match's stakes in a vault nobody has a key to and pays the podium out
of it. The design is in [docs/ESCROW.md](../docs/ESCROW.md); the owner's
decisions that shaped it are [SPEC-BACKLOG.md Round 16](../docs/SPEC-BACKLOG.md).

| | |
|---|---|
| Program ID | `Ctu4Q9hJKUksKZ9mXrydtua2LcuvmM8Wt34Xc6VK1wmj` |
| Cluster | devnet |
| Anchor | 1.2.0 (`@anchor-lang/core` on the client) |
| Tests | LiteSVM, in Rust — `./test.sh` |

## The flow

```
create_match   server opens a room; fixes fee, fee destination, minimum and refund delay
join           seated player signs the displayed entry amount; nothing moves while waiting
leave          player leaves; revoke only this match's approval while filling
evict          authority removes a Joined seat while the room is filling
collect        room locks: approved stakes enter the vault owned by the match
start          starts the match with at least 6 staked players and at most 40
settle         one settlement pays the top 3 what is left after the match's
               pinned fee (90% at the deployed 10%), split 50/30/20, and the
               fee to the platform, including any invite rewards taken from it
claim_refund   settlement refused after 30 minutes from collection; return every
               unpaid stake in full, with no fee deducted
cancel         an unpaid cancelled match's collected stakes become refundable
close_match    reclaim rent once the vault is empty
propose_authority / accept_authority   rotate control with both keys' signatures
```

While fewer than six players are staked, the lobby minute restarts and nothing
is taken. The platform sponsors every transaction; players never pay network
fees or need SOL. Sign-in is Google only; an embedded wallet is created for
the player. The app checks every transaction before that wallet signs it. On-chain
admission is signed by the platform only for players actually seated in the
room.

The room server reports the podium, and the escrow trusts that report. The
podium must contain collected stakers. If at least one podium finisher joined
through an invite, a total of 1% of the pool is paid to the inviters, out of the
platform's fee, split equally among the inviters of the invited podium
finishers. The podium's share (90% at the deployed 10%) is unchanged. Referral recipients may be
non-stakers. The fee, fee destination, minimum players and refund delay are
fixed at match creation. The 30-minute settlement window begins at collection;
after it expires, settlement is refused and every stake is returned in full,
without a fee deduction. The platform pays the refund network fees.

The program's upgrade key is a single offline key for now; a multisig will hold
it before or at mainnet. The key that pays out cannot change the program. The
mint's issuance/freeze authorities remain a separate trust boundary. RatPool is
live on Solana devnet with test USDC; mainnet follows an independent audit.

The v2 account seeds and cutover requirements are in [MIGRATION-v2.md](MIGRATION-v2.md).
The current devnet interface requires `join(id, expected_entry)`; the API and
client must match [UPGRADE-v5.md](UPGRADE-v5.md). Existing account layouts are
unchanged. The reviewed v5 binary passed all 78 contract tests and was verified
against the deployed devnet program on 24 November 2026.

## Building

Inside WSL2 with the toolchain from ESCROW.md §6:

```
./build.sh          # anchor build --arch v0, target dir on the Linux side
./test.sh           # LiteSVM scenarios against the last program build
```

`--arch v0` is not optional — see the comment in `build.sh`.

## Layout

```
programs/ratpool-escrow/src/
  lib.rs            the #[program] entry, one thin fn per instruction
  instructions/     one file per instruction: accounts + handler
  state.rs          Config, Match, Player and their enums
  events.rs         one event per state change, for explorers and the server
  error.rs          every refusal, named
  constants.rs      seeds, MAX_PLAYERS, the podium split, the fee ceiling
programs/ratpool-escrow/tests/
  escrow.rs         the suite; SPL accounts written by hand into LiteSVM
```
