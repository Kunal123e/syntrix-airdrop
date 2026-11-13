-- Phase 2 additive auth/rate-limit migration.
-- Review and apply only to a confirmed staging database first.
-- This migration does not alter existing Phase 1 tables or data.

begin;

do $preflight$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pgcrypto') then
    raise exception 'Phase 2 preflight failed: pgcrypto extension is required and must be installed before migration';
  end if;

  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    raise exception 'Phase 2 preflight failed: required Supabase roles are missing';
  end if;

  if to_regclass('public.syntrix_auth_otp_challenges') is not null
     or to_regclass('public.syntrix_auth_rate_events') is not null
     or to_regclass('public.syntrix_auth_sessions') is not null
     or to_regclass('public.syntrix_auth_otp_active_email_idx') is not null
     or to_regclass('public.syntrix_auth_rate_events_window_idx') is not null
     or to_regclass('public.syntrix_auth_sessions_active_idx') is not null
     or exists (
       select 1
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in (
            'syntrix_auth_issue_otp',
            'syntrix_auth_activate_otp',
            'syntrix_auth_invalidate_otp',
            'syntrix_auth_verify_otp',
            'syntrix_auth_validate_session',
            'syntrix_auth_revoke_session'
          )
     ) then
    raise exception 'Phase 2 preflight failed: one or more Phase 2 authentication objects already exist';
  end if;
end
$preflight$;

create table public.syntrix_auth_otp_challenges (
  challenge_id uuid primary key default gen_random_uuid(),
  email_principal text not null,
  email_key text not null,
  otp_digest text not null check (otp_digest ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  activated_at timestamptz,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 5),
  created_at timestamptz not null default now()
);

create index syntrix_auth_otp_active_email_idx
  on public.syntrix_auth_otp_challenges (email_key, created_at desc)
  where consumed_at is null;

create table public.syntrix_auth_rate_events (
  event_id bigint generated always as identity primary key,
  scope text not null check (scope in ('email', 'ip')),
  event_type text not null check (event_type in ('otp_send', 'otp_verify', 'otp_verify_failed')),
  key_digest text not null check (key_digest ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz not null default now(),
  suspicious boolean not null default false
);

create index syntrix_auth_rate_events_window_idx
  on public.syntrix_auth_rate_events (scope, event_type, key_digest, occurred_at desc);

create table public.syntrix_auth_sessions (
  session_id uuid primary key default gen_random_uuid(),
  email_principal text not null,
  session_hash text not null unique check (session_hash ~ '^[0-9a-f]{64}$'),
  purpose text not null check (purpose = 'syntrix-user-session'),
  audience text not null check (audience = 'syntrix-api'),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz
);

create index syntrix_auth_sessions_active_idx
  on public.syntrix_auth_sessions (session_hash, expires_at)
  where revoked_at is null;

alter table public.syntrix_auth_otp_challenges enable row level security;
alter table public.syntrix_auth_rate_events enable row level security;
alter table public.syntrix_auth_sessions enable row level security;

revoke all on public.syntrix_auth_otp_challenges from public, anon, authenticated;
revoke all on public.syntrix_auth_rate_events from public, anon, authenticated;
revoke all on public.syntrix_auth_sessions from public, anon, authenticated;

create function public.syntrix_auth_issue_otp(
  p_email_principal text,
  p_email_key text,
  p_ip_key text,
  p_otp_digest text,
  p_expires_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_email_count integer;
  v_ip_count integer;
  v_email_oldest timestamptz;
  v_ip_oldest timestamptz;
  v_last_email_send timestamptz;
  v_retry integer := 60;
  v_suspicious boolean := false;
begin
  if p_email_principal is null or p_email_principal = ''
     or p_email_key !~ '^[0-9a-f]{64}$'
     or p_ip_key !~ '^[0-9a-f]{64}$'
     or p_otp_digest !~ '^[0-9a-f]{64}$'
     or p_expires_at <= v_now
     or p_expires_at > v_now + interval '5 minutes' then
    return jsonb_build_object('status', 'invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_email_key, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_ip_key, 0));
  select count(*) into v_email_count
    from public.syntrix_auth_rate_events
   where scope = 'email' and event_type = 'otp_send'
     and key_digest = p_email_key
     and occurred_at >= v_now - interval '15 minutes';

  select max(occurred_at) into v_last_email_send
    from public.syntrix_auth_rate_events
   where scope = 'email' and event_type = 'otp_send'
     and key_digest = p_email_key;

  select count(*) into v_ip_count
    from public.syntrix_auth_rate_events
   where scope = 'ip' and event_type = 'otp_send'
     and key_digest = p_ip_key
     and occurred_at >= v_now - interval '15 minutes';

  if v_last_email_send is not null
     and v_last_email_send > v_now - interval '60 seconds' then
    v_retry := greatest(1, ceil(extract(epoch from (v_last_email_send + interval '60 seconds' - v_now)))::integer);
    return jsonb_build_object('status', 'rate_limited', 'retry_after_seconds', v_retry);
  end if;
  if v_email_count >= 3 then
    select min(occurred_at) into v_email_oldest from public.syntrix_auth_rate_events
     where scope = 'email' and event_type = 'otp_send' and key_digest = p_email_key
       and occurred_at >= v_now - interval '15 minutes';
    return jsonb_build_object('status', 'rate_limited',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_email_oldest + interval '15 minutes' - v_now)))::integer));
  end if;
  if v_ip_count >= 100 then
    select min(occurred_at) into v_ip_oldest from public.syntrix_auth_rate_events
     where scope = 'ip' and event_type = 'otp_send' and key_digest = p_ip_key
       and occurred_at >= v_now - interval '15 minutes';
    return jsonb_build_object('status', 'rate_limited',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_ip_oldest + interval '15 minutes' - v_now)))::integer));
  end if;

  v_suspicious := v_ip_count >= 59;
  insert into public.syntrix_auth_rate_events(scope, event_type, key_digest, occurred_at, suspicious)
  values ('email', 'otp_send', p_email_key, v_now, false),
         ('ip', 'otp_send', p_ip_key, v_now, v_suspicious);

  insert into public.syntrix_auth_otp_challenges(email_principal, email_key, otp_digest, expires_at)
  values (p_email_principal, p_email_key, p_otp_digest, p_expires_at);

  return jsonb_build_object('status', 'pending', 'suspicious', v_suspicious,
                            'challenge_id', (select challenge_id from public.syntrix_auth_otp_challenges
                                              where email_key = p_email_key and otp_digest = p_otp_digest
                                              order by created_at desc limit 1));
end;
$$;

create function public.syntrix_auth_activate_otp(p_challenge_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  update public.syntrix_auth_otp_challenges
     set activated_at = clock_timestamp()
   where challenge_id = p_challenge_id
     and activated_at is null
     and invalidated_at is null
     and consumed_at is null
     and expires_at > clock_timestamp();
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  return jsonb_build_object('status', 'activated');
end;
$$;

create function public.syntrix_auth_invalidate_otp(p_challenge_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  update public.syntrix_auth_otp_challenges
     set invalidated_at = clock_timestamp()
   where challenge_id = p_challenge_id
     and consumed_at is null
     and invalidated_at is null;
  return jsonb_build_object('status', 'invalidated');
end;
$$;

create function public.syntrix_auth_verify_otp(
  p_email_principal text,
  p_email_key text,
  p_ip_key text,
  p_otp_digest text,
  p_session_hash text,
  p_session_expires_at timestamptz,
  p_session_purpose text,
  p_session_audience text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_challenge public.syntrix_auth_otp_challenges%rowtype;
  v_ip_count integer;
  v_failed_count integer;
  v_failed_oldest timestamptz;
  v_verify_oldest timestamptz;
begin
  if p_email_principal is null or p_email_principal = ''
     or p_email_key !~ '^[0-9a-f]{64}$'
     or p_ip_key !~ '^[0-9a-f]{64}$'
     or p_otp_digest !~ '^[0-9a-f]{64}$'
     or p_session_hash !~ '^[0-9a-f]{64}$'
     or p_session_purpose <> 'syntrix-user-session'
     or p_session_audience <> 'syntrix-api'
     or p_session_expires_at <= v_now
     or p_session_expires_at > v_now + interval '12 hours' then
    return jsonb_build_object('status', 'invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_email_key, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_ip_key, 0));
  select count(*) into v_ip_count
    from public.syntrix_auth_rate_events
   where scope = 'ip' and event_type = 'otp_verify'
     and key_digest = p_ip_key
     and occurred_at >= v_now - interval '15 minutes';
  if v_ip_count >= 200 then
    select min(occurred_at) into v_verify_oldest from public.syntrix_auth_rate_events
     where scope = 'ip' and event_type = 'otp_verify' and key_digest = p_ip_key
       and occurred_at >= v_now - interval '15 minutes';
    return jsonb_build_object('status', 'rate_limited',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_verify_oldest + interval '15 minutes' - v_now)))::integer));
  end if;
  insert into public.syntrix_auth_rate_events(scope, event_type, key_digest, occurred_at)
  values ('ip', 'otp_verify', p_ip_key, v_now);

  select * into v_challenge
    from public.syntrix_auth_otp_challenges
   where email_key = p_email_key and consumed_at is null
     and activated_at is not null and invalidated_at is null
   order by created_at desc
   limit 1
   for update;

  if not found or v_challenge.expires_at <= v_now then
    return jsonb_build_object('status', 'invalid');
  end if;

  if v_challenge.otp_digest <> p_otp_digest then
    select count(*) into v_failed_count
      from public.syntrix_auth_rate_events
     where scope = 'email' and event_type = 'otp_verify_failed'
       and key_digest = p_email_key
       and occurred_at >= v_now - interval '15 minutes';
    if v_failed_count >= 5 or v_challenge.failed_attempts >= 5 then
      select min(occurred_at) into v_failed_oldest from public.syntrix_auth_rate_events
       where scope = 'email' and event_type = 'otp_verify_failed' and key_digest = p_email_key
         and occurred_at >= v_now - interval '15 minutes';
      return jsonb_build_object('status', 'rate_limited',
        'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_failed_oldest + interval '15 minutes' - v_now)))::integer));
    end if;

    update public.syntrix_auth_otp_challenges
       set failed_attempts = failed_attempts + 1
     where challenge_id = v_challenge.challenge_id
       and failed_attempts < 5;
    if not found then
      return jsonb_build_object('status', 'rate_limited', 'retry_after_seconds', 1);
    end if;

    insert into public.syntrix_auth_rate_events(scope, event_type, key_digest, occurred_at)
    values ('email', 'otp_verify_failed', p_email_key, v_now);
    return jsonb_build_object('status', 'invalid');
  end if;

  update public.syntrix_auth_otp_challenges
     set consumed_at = v_now
   where challenge_id = v_challenge.challenge_id and consumed_at is null;
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  insert into public.syntrix_auth_sessions(email_principal, session_hash, purpose, audience, expires_at, last_seen_at)
  values (p_email_principal, p_session_hash, p_session_purpose, p_session_audience, p_session_expires_at, v_now);
  return jsonb_build_object('status', 'accepted', 'expires_at', p_session_expires_at);
end;
$$;

create function public.syntrix_auth_validate_session(
  p_session_hash text,
  p_session_purpose text,
  p_session_audience text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_email text;
begin
  update public.syntrix_auth_sessions
     set last_seen_at = clock_timestamp()
   where session_hash = p_session_hash
     and purpose = p_session_purpose
     and audience = p_session_audience
     and purpose = 'syntrix-user-session'
     and audience = 'syntrix-api'
     and revoked_at is null
     and expires_at > clock_timestamp()
  returning email_principal into v_email;
  if v_email is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  return jsonb_build_object('status', 'active', 'email_principal', v_email,
                            'purpose', p_session_purpose, 'audience', p_session_audience);
/*
  select email_principal into v_email
    from public.syntrix_auth_sessions
   where session_hash = p_session_hash
     and revoked_at is null
     and expires_at > clock_timestamp();
  if v_email is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  return jsonb_build_object('status', 'active', 'email_principal', v_email);
*/
end;
$$;

create function public.syntrix_auth_revoke_session(
  p_session_hash text
) returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.syntrix_auth_sessions
     set revoked_at = clock_timestamp()
   where session_hash = p_session_hash and revoked_at is null;
  select jsonb_build_object('status', 'revoked');
$$;

create function public.syntrix_auth_cleanup(p_limit integer default 1000)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 1000), 10000));
  v_events integer;
  v_challenges integer;
  v_sessions integer;
begin
  with doomed as (
    select event_id from public.syntrix_auth_rate_events
     where occurred_at < clock_timestamp() - interval '15 minutes'
     order by occurred_at
     limit v_limit
  )
  delete from public.syntrix_auth_rate_events e using doomed d where e.event_id = d.event_id;
  get diagnostics v_events = row_count;

  with doomed as (
    select challenge_id from public.syntrix_auth_otp_challenges
     where (expires_at < clock_timestamp() - interval '1 day' or invalidated_at < clock_timestamp() - interval '1 day')
     order by created_at
     limit v_limit
  )
  delete from public.syntrix_auth_otp_challenges c using doomed d where c.challenge_id = d.challenge_id;
  get diagnostics v_challenges = row_count;

  with doomed as (
    select session_id from public.syntrix_auth_sessions
     where (expires_at < clock_timestamp() - interval '1 day'
            or revoked_at < clock_timestamp() - interval '1 day')
     order by issued_at
     limit v_limit
  )
  delete from public.syntrix_auth_sessions s using doomed d where s.session_id = d.session_id;
  get diagnostics v_sessions = row_count;
  return jsonb_build_object('status', 'cleaned', 'events', v_events,
                            'challenges', v_challenges, 'sessions', v_sessions);
end;
$$;

revoke all on function public.syntrix_auth_issue_otp(text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.syntrix_auth_activate_otp(uuid) from public, anon, authenticated;
revoke all on function public.syntrix_auth_invalidate_otp(uuid) from public, anon, authenticated;
revoke all on function public.syntrix_auth_verify_otp(text, text, text, text, text, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.syntrix_auth_validate_session(text, text, text) from public, anon, authenticated;
revoke all on function public.syntrix_auth_revoke_session(text) from public, anon, authenticated;
revoke all on function public.syntrix_auth_cleanup(integer) from public, anon, authenticated;
grant execute on function public.syntrix_auth_issue_otp(text, text, text, text, timestamptz) to service_role;
grant execute on function public.syntrix_auth_activate_otp(uuid) to service_role;
grant execute on function public.syntrix_auth_invalidate_otp(uuid) to service_role;
grant execute on function public.syntrix_auth_verify_otp(text, text, text, text, text, timestamptz, text, text) to service_role;
grant execute on function public.syntrix_auth_validate_session(text, text, text) to service_role;
grant execute on function public.syntrix_auth_revoke_session(text) to service_role;
grant execute on function public.syntrix_auth_cleanup(integer) to service_role;

commit;
