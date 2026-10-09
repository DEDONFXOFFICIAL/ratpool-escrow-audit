-- Request limits and referrals. Run once: Supabase → SQL Editor → New query →
-- paste → Run. Safe to run again; every statement is idempotent.
--
-- Both are written by the server functions only (the service role). Row level
-- security is on with no policy for the public key, so a browser can neither
-- read nor write them.

-- 1. Request limits ----------------------------------------------------------
--
-- A counter per key ("faucet:wallet:<address>", "faucet:ip:<hash>", ...) that
-- resets when its window runs out. bump_limit adds one and says whether the
-- key is still within its allowance, in one statement, so two requests at the
-- same moment cannot both slip under it.

create table if not exists public.api_limits (
  key       text primary key,
  count     integer not null default 0,
  reset_at  timestamptz not null
);
alter table public.api_limits enable row level security;

create or replace function public.bump_limit(k text, max_count integer, window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  c integer;
begin
  insert into public.api_limits as l (key, count, reset_at)
  values (k, 1, now() + make_interval(secs => window_seconds))
  on conflict (key) do update set
    count    = case when l.reset_at <= now() then 1 else l.count + 1 end,
    reset_at = case when l.reset_at <= now() then now() + make_interval(secs => window_seconds) else l.reset_at end
  returning l.count into c;
  return c <= max_count;
end;
$$;
revoke all on function public.bump_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.bump_limit(text, integer, integer) to service_role;

-- Old windows are dead weight; this clears them (run it whenever, or never).
create or replace function public.clear_old_limits()
returns void
language sql
security definer
set search_path = public
as $$ delete from public.api_limits where reset_at < now() - interval '1 day'; $$;
revoke all on function public.clear_old_limits() from public, anon, authenticated;
grant execute on function public.clear_old_limits() to service_role;

-- 2. Referrals -----------------------------------------------------------------
--
-- Attribution only: who brought whom. No money moves on any of it until the
-- referral rules are decided (owner, 2026-09-29).
--
--   referral_codes  one short code per player, made by the server.
--   referrals       one row per referred player, ever: the primary key is the
--                   new player's wallet, so a second claim cannot overwrite the
--                   first. verified_at is set once the new player has signed
--                   in and built their rat.

create table if not exists public.referral_codes (
  wallet      text primary key,
  code        text not null unique,
  created_at  timestamptz not null default now()
);
alter table public.referral_codes enable row level security;

create table if not exists public.referrals (
  referred_wallet  text primary key,
  referrer_wallet  text not null references public.referral_codes (wallet),
  code             text not null,
  created_at       timestamptz not null default now(),
  verified_at      timestamptz,
  constraint referrals_not_self check (referred_wallet <> referrer_wallet)
);
create index if not exists referrals_by_referrer on public.referrals (referrer_wallet);
alter table public.referrals enable row level security;

-- 3. The referral board ---------------------------------------------------------
--
-- The Leaderboard's second tab (owner, 2026-09-29): players ranked by the
-- friends they brought who joined (signed in and built a rat). It will rank
-- by referral earnings once the referral rules are decided; until then there
-- are none. The view reads the private tables with its owner's rights and
-- shows only totals per player, which is all the board needs.

create or replace view public.referral_board as
  select
    c.wallet,
    coalesce(p.name, c.wallet)                                                 as name,
    (count(r.referred_wallet) filter (where r.verified_at is not null))::integer as joined,
    count(r.referred_wallet)::integer                                          as invited
  from public.referral_codes c
  join public.referrals r on r.referrer_wallet = c.wallet
  left join public.profiles p on p.wallet = c.wallet
  group by c.wallet, p.name;
grant select on public.referral_board to anon, authenticated;

-- Check: both lists empty, the limiter answers.
select public.bump_limit('setup-check', 1, 60) as limiter_works;
select count(*) as codes from public.referral_codes;
select count(*) as referrals from public.referrals;
select count(*) as on_the_board from public.referral_board;
