-- Escrow v6 / seven-place points. Historical cash and skull rows are retained.
begin;
alter table public.matches add column if not exists economy_version smallint not null default 5;
alter table public.matches add column if not exists winner_weights integer[];
alter table public.free_play_sessions add column if not exists reward_version smallint not null default 1
  check (reward_version in (1, 2));
alter table public.free_play_sessions drop constraint if exists free_play_sessions_skulls_check;
alter table public.free_play_sessions add constraint free_play_sessions_skulls_check
  check (skulls in (10, 15, 20, 25, 30, 40, 45, 50));

create table public.referral_points_ledger (
  network text not null check (network in ('devnet', 'mainnet-beta', 'localnet')),
  program_id text not null,
  source_kind text not null check (source_kind in ('paid', 'free')),
  source_key text not null check (length(source_key) between 1 and 160),
  referred_wallet text not null references public.profiles(wallet) on delete cascade,
  referrer_wallet text not null references public.profiles(wallet) on delete cascade,
  points integer not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (network, program_id, source_kind, source_key, referred_wallet),
  check (referred_wallet <> referrer_wallet),
  check ((source_kind = 'paid' and points = 20 and length(program_id) between 32 and 44)
      or (source_kind = 'free' and points = 5 and program_id = ''))
);
create index referral_points_referrer on public.referral_points_ledger(network, referrer_wallet);
create index referral_points_friend on public.referral_points_ledger(referred_wallet);
create table public.referral_points_totals (
  network text not null check (network in ('devnet', 'mainnet-beta', 'localnet')),
  wallet text not null references public.profiles(wallet) on delete cascade,
  points bigint not null default 0 check (points >= 0),
  paid_wins integer not null default 0 check (paid_wins >= 0),
  free_wins integer not null default 0 check (free_wins >= 0),
  primary key (network, wallet)
);
create index referral_points_wallet on public.referral_points_totals(wallet);
alter table public.referral_points_ledger enable row level security;
alter table public.referral_points_totals enable row level security;
revoke all on public.referral_points_ledger, public.referral_points_totals from public, anon, authenticated;
grant all on public.referral_points_ledger, public.referral_points_totals to service_role;
create policy "public read" on public.referral_points_totals for select to anon, authenticated using (true);
grant select on public.referral_points_totals to anon, authenticated;
create view public.referral_points_leaderboard with (security_invoker = true) as
  select t.network, t.wallet, p.name, t.points, t.paid_wins, t.free_wins,
    (row_number() over (partition by t.network order by t.points desc, p.name asc, t.wallet asc))::integer as rank
  from public.referral_points_totals t join public.profiles p on p.wallet = t.wallet;
grant select on public.referral_points_leaderboard to anon, authenticated, service_role;

-- Internal service-only primitive. A client cannot choose an amount or parent.
create function public.credit_referral_points(
  p_network text, p_program_id text, p_kind text, p_source_key text, p_friend text, p_started_at timestamptz
) returns integer language plpgsql security invoker set search_path = '' as $$
declare parent text; award integer; inserted integer;
begin
  if p_network is null or p_network not in ('devnet', 'mainnet-beta', 'localnet')
    or p_kind is null or p_kind not in ('paid', 'free') or p_started_at is null
    or p_source_key is null or length(p_source_key) not between 1 and 160
    or p_program_id is null or (p_kind = 'free' and p_program_id <> '')
    or (p_kind = 'paid' and length(p_program_id) not between 32 and 44) then
    raise exception 'Invalid referral point source';
  end if;
  select r.referrer_wallet into parent from public.referrals r
    join public.profiles p on p.wallet = r.referrer_wallet
    where r.referred_wallet = p_friend and r.referrer_wallet <> p_friend
      and r.verified_at is not null and r.created_at <= p_started_at;
  if not found then return 0; end if;
  award := case p_kind when 'paid' then 20 else 5 end;
  insert into public.referral_points_ledger(network, program_id, source_kind, source_key,
    referred_wallet, referrer_wallet, points)
    values(p_network, p_program_id, p_kind, p_source_key, p_friend, parent, award)
    on conflict do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then return 0; end if;
  insert into public.referral_points_totals(network, wallet, points, paid_wins, free_wins)
    values(p_network, parent, award, case when p_kind = 'paid' then 1 else 0 end,
      case when p_kind = 'free' then 1 else 0 end)
    on conflict (network, wallet) do update set
      points = referral_points_totals.points + excluded.points,
      paid_wins = referral_points_totals.paid_wins + excluded.paid_wins,
      free_wins = referral_points_totals.free_wins + excluded.free_wins;
  return award;
end $$;

-- Called only after the API verifies a confirmed escrow-v6 receipt.
create function public.credit_paid_referral_points(
  p_network text, p_program_id text, p_source_key text, p_winners text[], p_started_at timestamptz
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare friend text; credited integer := 0;
begin
  if p_winners is null or cardinality(p_winners) not between 1 and 12
    or cardinality(p_winners) <> (select count(distinct w) from unnest(p_winners) w)
    or array_position(p_winners, null) is not null then
    raise exception 'Invalid confirmed winners';
  end if;
  foreach friend in array p_winners loop
    credited := credited + public.credit_referral_points(p_network, p_program_id, 'paid', p_source_key, friend, p_started_at);
  end loop;
  return jsonb_build_object('ok', true, 'credited', credited);
end $$;

create function public.start_free_play_session_versioned(
  p_network text, p_wallet text, p_session uuid, p_reward_version integer
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare s public.free_play_sessions;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_network || ':' || p_wallet, 0));
  if p_reward_version is null or p_reward_version not in (1, 2) or p_session is null
    or p_network is null or p_network not in ('devnet', 'mainnet-beta', 'localnet')
    or not exists(select 1 from public.profiles where wallet = p_wallet) then
    return jsonb_build_object('ok', false, 'error', 'Create your player profile first.');
  end if;
  select * into s from public.free_play_sessions where id = p_session;
  if found then
    if s.wallet <> p_wallet or s.network <> p_network or s.state <> 'active' or s.reward_version <> p_reward_version then
      return jsonb_build_object('ok', false, 'error', 'This session cannot be started.');
    end if;
    return jsonb_build_object('ok', true, 'session', s.id, 'reward_version', s.reward_version);
  end if;
  update public.free_play_sessions set state = case
    when started_at <= clock_timestamp() - interval '590 seconds' then 'claimable' else 'abandoned' end
    where network = p_network and wallet = p_wallet and state = 'active';
  insert into public.free_play_sessions(id, network, wallet, reward_version)
    values(p_session, p_network, p_wallet, p_reward_version);
  return jsonb_build_object('ok', true, 'session', p_session, 'reward_version', p_reward_version);
end $$;

create function public.finish_free_play_session_versioned(
  p_network text, p_wallet text, p_session uuid, p_rank integer, p_elapsed_ms integer, p_reward_version integer
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare s public.free_play_sessions; award integer; total integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_network || ':' || p_wallet, 0));
  select * into s from public.free_play_sessions where id = p_session for update;
  if not found or s.wallet <> p_wallet or s.network <> p_network then
    return jsonb_build_object('ok', false, 'error', 'Free Play session not found.');
  end if;
  if p_reward_version is null or p_reward_version <> s.reward_version then
    return jsonb_build_object('ok', false, 'error', 'This match uses a different reward version.');
  end if;
  if s.state = 'completed' then
    select skulls into total from public.free_play_totals where network = p_network and wallet = p_wallet;
    return jsonb_build_object('ok', true, 'session', s.id, 'awarded', s.skulls, 'total', total, 'reward_version', s.reward_version);
  end if;
  if s.state not in ('active', 'claimable') or p_rank is null or p_rank not between 1 and 40
    or p_elapsed_ms is null or p_elapsed_ms not between 600000 and 630000
    or s.started_at > clock_timestamp() - interval '590 seconds'
    or s.started_at < clock_timestamp() - interval '2 days' then
    return jsonb_build_object('ok', false, 'error', 'Only a completed Free Play match can earn skulls.');
  end if;
  award := case when s.reward_version = 1 then
    case p_rank when 1 then 50 when 2 then 30 when 3 then 20 else 10 end
    else coalesce((array[50,45,40,30,25,20,15])[p_rank], 10) end;
  insert into public.free_play_totals(network, wallet, skulls, matches) values(p_network, p_wallet, award, 1)
    on conflict (network, wallet) do update set skulls = free_play_totals.skulls + excluded.skulls,
      matches = free_play_totals.matches + 1 returning skulls into total;
  update public.free_play_sessions set state = 'completed', rank = p_rank, skulls = award,
    completed_at = clock_timestamp() where id = p_session;
  if s.reward_version = 2 and p_rank <= 7 then
    perform public.credit_referral_points(p_network, '', 'free', p_session::text, p_wallet, s.started_at);
  end if;
  return jsonb_build_object('ok', true, 'session', p_session, 'awarded', award, 'total', total, 'reward_version', s.reward_version);
end $$;

-- Old installed clients finish their original rewards; they cannot upgrade a
-- v1 clock or submit an unversioned proof for a new v2 clock.
create or replace function public.start_free_play_session(p_network text, p_wallet text, p_session uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select public.start_free_play_session_versioned(p_network, p_wallet, p_session, 1);
$$;
create or replace function public.finish_free_play_session(
  p_network text, p_wallet text, p_session uuid, p_rank integer, p_elapsed_ms integer
) returns jsonb language sql security invoker set search_path = '' as $$
  select public.finish_free_play_session_versioned(p_network, p_wallet, p_session, p_rank, p_elapsed_ms, 1);
$$;
revoke all on function public.credit_referral_points(text,text,text,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.credit_paid_referral_points(text,text,text,text[],timestamptz) from public, anon, authenticated;
revoke all on function public.start_free_play_session_versioned(text,text,uuid,integer) from public, anon, authenticated;
revoke all on function public.finish_free_play_session_versioned(text,text,uuid,integer,integer,integer) from public, anon, authenticated;
grant execute on function public.credit_referral_points(text,text,text,text,text,timestamptz) to service_role;
grant execute on function public.credit_paid_referral_points(text,text,text,text[],timestamptz) to service_role;
grant execute on function public.start_free_play_session_versioned(text,text,uuid,integer) to service_role;
grant execute on function public.finish_free_play_session_versioned(text,text,uuid,integer,integer,integer) to service_role;
notify pgrst, 'reload schema';
commit;
