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
start          starts the match with at least 25 staked players; game cap 40, contract cap 50
settle         one settlement pays the top 7 what is left after the match's
               pinned fee (90% at the deployed 10%), weights 10/9/8/6/5/4/3, and the
               entire fee to the platform; no cash referral transfer
claim_refund   settlement refused after 30 minutes from collection; return every
               unpaid stake in full, with no fee deducted
cancel         an unpaid cancelled match's collected stakes become refundable
close_match    reclaim rent once the vault is empty
propose_authority / accept_authority   rotate control with both keys' signatures
```

While fewer than twenty-five players are staked, the lobby minute restarts and nothing
is taken. The platform sponsors every transaction; players never pay network
fees or need SOL. Sign-in is Google only; an embedded wallet is created for
the player. The app checks every transaction before that wallet signs it. On-chain
admission is signed by the platform only for players actually seated in the
room.

The room server reports the podium, and the escrow trusts that report. The
podium must contain collected stakers. Each match pins its winner count,
payout weights, fee, fee destination, minimum players and refund delay at
creation. The default seven winners receive 20/18/16/12/10/8/6% of the gross
pot at a 10% fee. Referral awards are database leaderboard points (20 paid,
5 Free Play per direct invited top-seven finisher), never USDC.
The 30-minute settlement window begins at collection;
after it expires, settlement is refused and every stake is returned in full,
without a fee deduction. The platform pays the refund network fees.

The program's upgrade key is a single offline key for now; a multisig will hold
it before or at mainnet. The key that pays out cannot change the program. The
mint's issuance/freeze authorities remain a separate trust boundary. RatPool is
live on Solana devnet with test USDC; mainnet follows an independent audit.

The current v6 interface uses `config_v6` and `match_v6` seeds and the
`ratpool-settle-v6` signed domain. The guard and referral addresses stay the
same. See [UPGRADE-v6.md](UPGRADE-v6.md) for the coordinated cutover;
v5 deployment records are historical. Source changes alone do not establish
which binary is deployed. `join(id, expected_entry)` remains required.
