import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

// Isolated PostgreSQL only. No production URL or arbitrary database accepted.
const bin = process.env.FREE_PLAY_TEST_PG_BIN || 'C:/Program Files/PostgreSQL/17/bin';
const port = process.env.FREE_PLAY_TEST_PORT || '55439';
assert.match(port, /^\d{4,5}$/);
const psql = join(bin, process.platform === 'win32' ? 'psql.exe' : 'psql');
const common = ['-X', '-h', '127.0.0.1', '-p', port, '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'];
const run = (query, db = 'ratpool_economy_v6_test') => execFileSync(psql, [...common, '-d', db],
  { input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().replaceAll('\r\n', '\n');
run("select 'create database ratpool_economy_v6_test' where not exists(select from pg_database where datname='ratpool_economy_v6_test')\n\\gexec", 'postgres');
assert.equal(run('select current_database();'), 'ratpool_economy_v6_test');
run(`do $$ begin
  if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
end $$;
drop schema public cascade; create schema public;
grant usage on schema public to anon, authenticated, service_role;`);
for (const path of ['supabase/schema.sql', 'supabase/2026-09-29-limits-and-referrals.sql',
  'supabase/2026-09-30-earnings-purchases-privacy.sql', 'supabase/2026-11-25-free-play-leaderboard.sql']) run(readFileSync(path, 'utf8'));
run('grant select,insert,update,delete on all tables in schema public to service_role; grant select on public.profiles to anon,authenticated;');
run(`insert into public.profiles(wallet,name) values('human','Player'),('parent','Inviter'),('late','Late'),('child','Child');
  insert into public.referral_codes(wallet,code) values('parent','TEST'),('late','LATE');
  insert into public.referrals(referred_wallet,referrer_wallet,code,created_at,verified_at)
  values('human','parent','TEST',now()-interval '2 days',now()-interval '2 days'),
    ('child','late','TEST',now(),now());`);
const legacy = randomUUID();
const call = (name, args) => JSON.parse(run(`set role service_role; select public.${name}(${args});`).split('\n').at(-1));
const start = (id, version = 2, wallet = 'human', network = 'devnet') => call('start_free_play_session_versioned', `'${network}','${wallet}','${id}',${version}`);
const finish = (id, rank = 1, version = 2, wallet = 'human', network = 'devnet') => call('finish_free_play_session_versioned', `'${network}','${wallet}','${id}',${rank},600000,${version}`);
const age = (id) => run(`update public.free_play_sessions set started_at=clock_timestamp()-interval '601 seconds' where id='${id}';`);
call('start_free_play_session', `'devnet','human','${legacy}'`); age(legacy);
run(readFileSync('supabase/migrations/20261126201639_economy_v6_points.sql', 'utf8'));
assert.equal(finish(legacy, 2, 1).awarded, 30);
assert.equal(run('select count(*) from public.referral_points_ledger;'), '0');
const table = [50,45,40,30,25,20,15];
for (let rank = 1; rank <= 40; rank++) {
  const id = randomUUID(); assert.equal(start(id).ok, true);
  assert.equal(finish(id, rank).ok, false); // accelerated client clock
  age(id);
  assert.equal(finish(id, rank, 1).ok, false); // version downgrade
  assert.equal(finish(id, rank, 2, 'child').ok, false); // ownership
  assert.equal(finish(id, rank, 2, 'human', 'mainnet-beta').ok, false);
  assert.equal(finish(id, rank).awarded, table[rank-1] ?? 10);
  assert.equal(finish(id, 1).awarded, table[rank-1] ?? 10); // immutable replay
}
assert.equal(run("select points from public.referral_points_totals where wallet='parent';"), '35');
const parallel = randomUUID(); start(parallel); age(parallel);
await Promise.all(Array.from({ length: 5 }, () => promisify(execFile)(psql, [...common, '-d', 'ratpool_economy_v6_test', '-c',
  `set role service_role; select public.finish_free_play_session_versioned('devnet','human','${parallel}',7,600000,2);`])));
assert.equal(run("select points from public.referral_points_totals where wallet='parent';"), '40');
const paidArgs = "'devnet','Ctu4Q9hJKUksKZ9mXrydtua2LcuvmM8Wt34Xc6VK1wmj','confirmed-match:123',array['human','child'],now()-interval '1 hour'";
assert.equal(call('credit_paid_referral_points', paidArgs).credited, 20); // late invite excluded
assert.equal(call('credit_paid_referral_points', paidArgs).credited, 0);
assert.equal(run("select points from public.referral_points_totals where wallet='parent';"), '60');
assert.equal(start(randomUUID(), 2, 'bot-with-no-profile').ok, false);
assert.equal(run("select count(*) from public.referral_points_totals where wallet='late';"), '0');
for (const role of ['anon','authenticated']) {
  assert.equal(run(`select has_table_privilege('${role}','public.referral_points_ledger','select');`), 'f');
  assert.equal(run(`select has_table_privilege('${role}','public.referral_points_totals','insert');`), 'f');
  for (const signature of ['credit_referral_points(text,text,text,text,text,timestamptz)',
    'credit_paid_referral_points(text,text,text,text[],timestamptz)',
    'finish_free_play_session_versioned(text,text,uuid,integer,integer,integer)']) {
    assert.equal(run(`select has_function_privilege('${role}','public.${signature}','execute');`), 'f');
  }
  assert.equal(run(`set role ${role}; select points from public.referral_points_leaderboard where wallet='parent';`).split('\n').at(-1), '60');
}
console.log('PASS: actual PostgreSQL v6 migration, 40 placement awards, legacy session preservation, ownership/version/timer checks, concurrent exactly-once referrals, invite timing and public/private grants.');
