# Seven-winner devnet upgrade

The devnet contract was upgraded on 27 November 2026. The coordinated service
cutover keeps paid pools paused until the API, worker and clients match.

The program ID stays `Ctu4Q9hJKUksKZ9mXrydtua2LcuvmM8Wt34Xc6VK1wmj`.
Only devnet is authorized. New layouts use `config_v6` and `match_v6`;
`guard`, `referral` and wallet token accounts retain their addresses.

Defaults: 25-player minimum, game maximum 40, contract maximum 50; seven
weights `10 / 9 / 8 / 6 / 5 / 4 / 3`, full 1,000-bps platform fee, existing
refund delay. Each new match copies its payout policy, so future configuration
changes cannot reprice an existing match. The upgrade authority can configure
up to twelve winners; the API currently refuses to open policies over seven
until their larger settlement transport is implemented and validated.

The room signs `ratpool-settle-v6`, program ID, match ID, collection time,
count and ranked wallets. It sends the pinned winner count. Settlement pays
only usual winner token accounts and the pinned fee account; extra referral
destinations are rejected. Its receipt records the economy version, weights
and collection time for idempotent result/referral recovery after closure.

## Cutover order

1. Finish contract, API, worker, SQL, shared-client and release checks. Preserve
   the deployed v5 binary and IDL. Verify the new binary hash and actual devnet
   upgrade authority before any transaction.
2. Deploy `PAID_POOLS_PAUSED=1` on the existing v5 API. Block new openings,
   sponsored joins and collection; keep settlement, cancellation, refunds,
   leaves and Free Play operating. Inspect old accounts and token vaults
   after the gate is verified. Drain and close **all** legacy matches.
3. Recheck zero legacy accounts and liabilities immediately before upgrading.
   Deploy the reviewed v6 binary; initialize the new config with the same
   mint, fee wallet, admission key and refund delay. Restore the existing
   payout authority through the normal propose/accept procedure. Verify the
   retained room guard and referral records; do not replace their keys.
4. Apply the tested `20261126201639_economy_v6_points.sql` migration. Old
   financial results are retained. Old Free Play clocks finish v1 awards;
   new signed v2 clocks use the seven-place schedule. Only service-role RPCs
   award referral points. No historical cash awards are converted.
5. Deploy the matching API and worker while paid pools remain paused. Verify
   25 minimum, seven pinned winners and v6 signatures on every service.
   Deploy the web/demo and the new signed Android artifacts.
6. Verify service health, deployment source, contract/configuration, boards,
   download artifacts and referral handoff. Resume paid pools only when the
   versions agree. Refresh the public audit export from the released commit.

The old binary cannot service newly created v6 matches. A rollback after
new stakes exist requires draining/refunding those v6 matches first. Avoid
blind binary rollback. Google Play update metadata must remain unchanged
until the new bundle is actually available on Google Play.

## Verified devnet deployment, 27 November 2026

- Binary SHA-256: `bd2d4facf9fecbc86e3523710a1350a41bb9d5ad098c6d87bd8f571855dc7840`.
- Upgrade transaction: `YhGFo9ffjNbtTD5GM41Ma2CdwRv1w6Ns2amrgfqFH7cqvdzNeXF6hE9Sq3kYyEYZPgVJTs4ZMoKvCErCLNfS9Ap`.
- New config: `6TW81y2erWspBMXhde9iCbKTGjhfxDP1ghwr8SMMWXNo`.
- Verified deployed executable bytes against the tested build; 80 contract tests pass.
- Config: 25 minimum, seven winners, weights 10/9/8/6/5/4/3, 1,000-bps fee,
  existing 1,800-second refund delay. Existing payout authority, admission,
  mint, fee wallet, room guard and both referral records were preserved.
- Fresh pre-upgrade inventory contained zero match accounts. No legacy stakes
  required migration or refund. Mainnet was not changed.

A zero-stake operator lifecycle check also created, inspected, cancelled and
closed a v6 match on devnet. It confirmed the 25-player minimum and seven
pinned winners without creating player records or charging player stakes.
Transactions: `3kYSGWKsqBV3GComNj72XyK2ZE2pdpNfcjBrNQkqkCBjaRzkLv8kFCXccHkegbBd9T18nJcerEfLwhgWbQXy5XYg`,
`56fjELcYn8DfGie4bPSDsVguBisXzXVzMVWxFVSJwxb2zUwg5XeiCEeBs49pw8bqQmXYdJPz2xGMxHNmJGmz9apn`,
`5w7nJiSjcbTtcd4VCu2K3rzSGWPGgNyYQYJhpD9GzB37abJXHExoRoS8NERVmxw8KLh22e1KryP4kyh6V1GDk6oJ`.
This is not a completed 25-human gameplay session; that test remains separate.
