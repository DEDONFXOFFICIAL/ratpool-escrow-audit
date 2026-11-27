-- Free Play is a separate, network-scoped ladder. No token transactions.
-- Run after schema.sql and the dated September migrations, before deploying
-- the matching API/client. Safe to rerun; existing totals are never reset.
begin;

create table if not exists public.free_play_sessions (
  id uuid primary key,
  network text not null check (network in ('devnet', 'mainnet-beta', 'localnet')),
  wallet text not null references public.profiles(wallet) on delete cascade,
  started_at timestamptz not null default clock_timestamp(),
  state text not null default 'active' check (state in ('active', 'claimable', 'completed', 'abandoned')),
  completed_at timestamptz,
  rank integer check (rank between 1 and 40),
  skulls integer check (skulls in (10, 20, 30, 50))
);
create unique index if not exists free_play_one_active
  on public.free_play_sessions(network, wallet) where state = 'active';
create index if not exists free_play_wallet on public.free_play_sessions(network, wallet);

create table if not exists public.free_play_totals (
  network text not null check (network in ('devnet', 'mainnet-beta', 'localnet')),
  wallet text not null references public.profiles(wallet) on delete cascade,
  skulls integer not null default 0 check (skulls >= 0),
  matches integer not null default 0 check (matches >= 0),
  primary key (network, wallet)
);
alter table public.free_play_sessions enable row level security;
alter table public.free_play_totals enable row level security;
revoke all on public.free_play_sessions, public.free_play_totals from anon, authenticated;
grant all on public.free_play_sessions, public.free_play_totals to service_role;
drop policy if exists "public read" on public.free_play_totals;
create policy "public read" on public.free_play_totals for select using (true);
grant select on public.free_play_totals to anon, authenticated;

create or replace view public.free_play_leaderboard with (security_invoker = true) as
  select t.network, t.wallet, p.name, t.skulls, t.matches,
    (row_number() over (partition by t.network order by t.skulls desc, p.name asc, t.wallet asc))::integer as rank
  from public.free_play_totals t join public.profiles p on p.wallet = t.wallet;
grant select on public.free_play_leaderboard to anon, authenticated;

-- The API verifies the wallet signature. Browsers cannot execute these RPCs.
-- Client-generated session UUID makes a lost start response safe to retry.
create or replace function public.start_free_play_session(p_network text, p_wallet text, p_session uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.free_play_sessions;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_network || ':' || p_wallet, 0));
  if p_network not in ('devnet', 'mainnet-beta', 'localnet')
     or not exists(select 1 from public.profiles where wallet = p_wallet) then
    return jsonb_build_object('ok', false, 'error', 'Create your player profile first.');
  end if;
  select * into s from public.free_play_sessions where id = p_session;
  if found then
    if s.wallet <> p_wallet or s.network <> p_network or s.state <> 'active' then
      return jsonb_build_object('ok', false, 'error', 'This session cannot be started.');
    end if;
    return jsonb_build_object('ok', true, 'session', s.id);
  end if;
  -- One clock per account: a second tab cannot bank a parallel match. A
  -- finished offline claim survives starting the next match for up to 2 days.
  update public.free_play_sessions set state = case
    when started_at <= clock_timestamp() - interval '590 seconds' then 'claimable'
    else 'abandoned' end
    where network = p_network and wallet = p_wallet and state = 'active';
  insert into public.free_play_sessions(id, network, wallet) values(p_session, p_network, p_wallet);
  return jsonb_build_object('ok', true, 'session', p_session);
end $$;

create or replace function public.finish_free_play_session(
  p_network text, p_wallet text, p_session uuid, p_rank integer, p_elapsed_ms integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.free_play_sessions; award integer; total integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_network || ':' || p_wallet, 0));
  select * into s from public.free_play_sessions where id = p_session for update;
  if not found or s.wallet <> p_wallet or s.network <> p_network then
    return jsonb_build_object('ok', false, 'error', 'Free Play session not found.');
  end if;
  if s.state = 'completed' then
    select skulls into total from public.free_play_totals where network = p_network and wallet = p_wallet;
    return jsonb_build_object('ok', true, 'session', s.id, 'awarded', s.skulls, 'total', total);
  end if;
  if s.state not in ('active', 'claimable') or p_rank is null or p_rank not between 1 and 40
     or p_elapsed_ms is null or p_elapsed_ms not between 600000 and 630000
     or s.started_at > clock_timestamp() - interval '590 seconds'
     or s.started_at < clock_timestamp() - interval '2 days' then
    return jsonb_build_object('ok', false, 'error', 'Only a completed Free Play match can earn skulls.');
  end if;
  award := case p_rank when 1 then 50 when 2 then 30 when 3 then 20 else 10 end;
  insert into public.free_play_totals(network, wallet, skulls, matches) values(p_network, p_wallet, award, 1)
    on conflict (network, wallet) do update set
      skulls = free_play_totals.skulls + excluded.skulls,
      matches = free_play_totals.matches + 1
    returning skulls into total;
  update public.free_play_sessions set state = 'completed', rank = p_rank, skulls = award,
    completed_at = clock_timestamp() where id = p_session;
  return jsonb_build_object('ok', true, 'session', p_session, 'awarded', award, 'total', total);
end $$;

revoke all on function public.start_free_play_session(text, text, uuid) from public, anon, authenticated;
revoke all on function public.finish_free_play_session(text, text, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.start_free_play_session(text, text, uuid) to service_role;
grant execute on function public.finish_free_play_session(text, text, uuid, integer, integer) to service_role;
notify pgrst, 'reload schema';
commit;
