-- DO NOT RUN UNLESS ROLLBACK IS EXPLICITLY APPROVED.
-- Phase 2 auth rollback/disable strategy.
-- Do not run automatically. Prefer disabling PHASE2_AUTH_RPC_ENABLED and
-- PHASE2_AUTH_ENFORCE_SESSIONS first, then review these destructive drops.

begin;

revoke all on function public.syntrix_auth_issue_otp(text, text, text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.syntrix_auth_verify_otp(text, text, text, text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.syntrix_auth_validate_session(text) from public, anon, authenticated, service_role;
revoke all on function public.syntrix_auth_revoke_session(text) from public, anon, authenticated, service_role;
revoke all on function public.syntrix_auth_cleanup(integer) from public, anon, authenticated, service_role;

drop function if exists public.syntrix_auth_issue_otp(text, text, text, text, timestamptz);
drop function if exists public.syntrix_auth_verify_otp(text, text, text, text, text, timestamptz);
drop function if exists public.syntrix_auth_validate_session(text);
drop function if exists public.syntrix_auth_revoke_session(text);
drop function if exists public.syntrix_auth_cleanup(integer);

drop table if exists public.syntrix_auth_sessions;
drop table if exists public.syntrix_auth_rate_events;
drop table if exists public.syntrix_auth_otp_challenges;

commit;
