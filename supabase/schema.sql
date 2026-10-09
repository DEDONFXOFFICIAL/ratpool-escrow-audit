-- RatPool — the records behind the wallet.
--
-- Run once in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- Safe to run again; every statement is idempotent.
--
-- What lives here and why:
--   profiles   the rat behind a wallet — name and look — so it follows the
--              wallet across devices. Written only by the server, after the
--              wallet has signed a message saying so (api/profile.ts).
--   matches    every room the server opened on chain, and what became of it.
--   results    who staked in a settled match, where they finished, what they
--              were paid, and the skulls that finish was worth.
--   leaderboard  the board, summed from results. One board for everyone.
--
-- The chain is the source of truth for money; these tables are the record
-- the game reads. Nothing in the escrow depends on them being up.
--
-- Access: anyone may read (the anon key in the client). Only the service
-- role — the server functions — may write. Row level security enforces it.

create table if not exists public.profiles (
  wallet      text primary key,
  name        text not null,
  traits      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.matches (
  id          text primary key,                 -- the program's u64 match id, as text
  tier        text not null,                    -- t1..t4
  entry       numeric(20,6) not null,           -- USDC per seat
  state       text not null,                    -- open | collected | settled | cancelled | closed
  stakers     integer not null default 0,
  pool        numeric(20,6) not null default 0,
  fee         numeric(20,6) not null default 0,
  signature   text,                             -- the settle transaction
  opened_at   timestamptz not null default now(),
  settled_at  timestamptz
);

create table if not exists public.results (
  match_id    text not null references public.matches(id) on delete cascade,
  wallet      text not null,
  rank        integer not null,
  payout      numeric(20,6) not null default 0,
  skulls      integer not null default 0,
  primary key (match_id, wallet)
);
create index if not exists results_wallet on public.results (wallet);

-- Everything else about a player, so the account is the same on every device:
-- settings, HUD layout, loadout, skulls, stats, history, tier progress, terms.
-- One JSON document per wallet, written only by /api/account after the wallet
-- has signed it.
create table if not exists public.accounts (
  wallet      text primary key,
  state       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
alter table public.accounts enable row level security;
drop policy if exists "public read" on public.accounts;
create policy "public read" on public.accounts for select using (true);

create or replace view public.leaderboard
  with (security_invoker = true) as
  select
    r.wallet,
    coalesce(p.name, r.wallet)  as name,
    sum(r.skulls)::integer      as skulls,
    count(*)::integer           as matches,
    sum(r.payout)               as earnings
  from public.results r
  left join public.profiles p on p.wallet = r.wallet
  group by r.wallet, p.name;

alter table public.profiles enable row level security;
alter table public.matches  enable row level security;
alter table public.results  enable row level security;

drop policy if exists "public read" on public.profiles;
drop policy if exists "public read" on public.matches;
drop policy if exists "public read" on public.results;
create policy "public read" on public.profiles for select using (true);
create policy "public read" on public.matches  for select using (true);
create policy "public read" on public.results  for select using (true);
