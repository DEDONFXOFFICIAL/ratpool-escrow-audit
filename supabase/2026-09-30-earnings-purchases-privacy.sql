-- Referral earnings, purchase records, private accounts. Run once, AFTER
-- 2026-09-29-limits-and-referrals.sql: Supabase → SQL Editor → New query →
-- paste → Run. Safe to run again: the carry-over below takes only accounts
-- last saved before it first ran, so a rerun can never turn what an account
-- claims today into a purchase (review 2026-10-06, DB-07).
--
-- The owner's rule (2026-09-30): 1% of every pool goes to the referrers of the
-- podium finishers who came through an invite, split equally, out of the
-- platform's 5%, paid by the escrow in the same settlement as the podium.
-- Each settled match writes what each referrer earned here (api/match/
-- settle.ts); one row per match and referred finisher, so a retried write
-- never counts twice.

create table if not exists public.referral_earnings (
  match_id         text not null,
  referred_wallet  text not null,
  referrer_wallet  text not null,
  amount           numeric not null,
  created_at       timestamptz not null default now(),
  primary key (match_id, referred_wallet)
);
create index if not exists referral_earnings_by_referrer on public.referral_earnings (referrer_wallet);
alter table public.referral_earnings enable row level security;

-- The referral board, now ranked by what referrers earned (owner: "based on
-- how much they've earned from the referral"), with friends who joined kept
-- as the tie-break and for the invite window.
drop view if exists public.referral_board;
create view public.referral_board as
  select
    c.wallet,
    coalesce(p.name, c.wallet)                                                   as name,
    coalesce(e.earned, 0)                                                        as earned,
    (count(r.referred_wallet) filter (where r.verified_at is not null))::integer as joined,
    count(r.referred_wallet)::integer                                            as invited
  from public.referral_codes c
  join public.referrals r on r.referrer_wallet = c.wallet
  left join public.profiles p on p.wallet = c.wallet
  left join (
    select referrer_wallet, sum(amount) as earned
    from public.referral_earnings
    group by referrer_wallet
  ) e on e.referrer_wallet = c.wallet
  group by c.wallet, p.name, e.earned;
grant select on public.referral_board to anon, authenticated;

-- Purchases ----------------------------------------------------------------------
--
-- One row per store payment, written by the server only after it has read the
-- payment back from the chain (api/store/buy.ts); the transaction signature is
-- the key, so a payment can never count twice. The rooms let a player bring
-- only the weapons they have a row for. Who owns what is public (it is on
-- chain anyway); nobody but the server writes.

create table if not exists public.purchases (
  signature   text primary key,
  wallet      text not null,
  item        text not null,
  amount      numeric not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists purchases_by_wallet on public.purchases (wallet);
alter table public.purchases enable row level security;
drop policy if exists "public read" on public.purchases;
create policy "public read" on public.purchases for select using (true);
grant select on public.purchases to anon, authenticated;

-- Everything bought before today, carried over from each account so nobody
-- loses a weapon they already own. Fixed to accounts as they stood on the
-- day: an account document is the player's own signed claim, and a rerun
-- after that day must not promote a new claim to a purchase.
insert into public.purchases (signature, wallet, item, amount)
select 'owned-before-2026-09-30:' || a.wallet || ':' || it.item, a.wallet, it.item, 0
from public.accounts a
cross join lateral jsonb_array_elements_text(
  case when jsonb_typeof(a.state -> 'loadout' -> 'owned') = 'array' then a.state -> 'loadout' -> 'owned' else '[]'::jsonb end
) as it(item)
where a.updated_at < timestamptz '2026-10-01 00:00:00+00'
  and it.item in ('w_smg', 'w_rifle', 'w_shotgun', 'w_sniper', 'w_rocket', 'w_cutlass')
on conflict (signature) do nothing;

-- Private account documents ----------------------------------------------------
--
-- Settings, match history and progress were readable by anyone with the
-- public key. Only the wallet and when it was saved stay public; the app reads
-- its own document through the server with a wallet signature.

revoke select on public.accounts from anon, authenticated;
grant select (wallet, updated_at) on public.accounts to anon, authenticated;

-- Check: the board answers, purchases carried over, accounts private.
select count(*) as on_the_board from public.referral_board;
select count(*) as purchases_carried_over from public.purchases;
