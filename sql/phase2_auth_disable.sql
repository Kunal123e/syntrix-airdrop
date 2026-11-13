-- Non-destructive Phase 2 disable strategy.
-- First set PHASE2_AUTH_RPC_ENABLED=false and
-- PHASE2_AUTH_ENFORCE_SESSIONS=false in the application environment.
-- This preserves auth records for audit/recovery and stops new RPC use.

revoke execute on function public.syntrix_auth_issue_otp(text, text, text, text, timestamptz) from service_role;
revoke execute on function public.syntrix_auth_verify_otp(text, text, text, text, text, timestamptz) from service_role;
revoke execute on function public.syntrix_auth_validate_session(text) from service_role;
revoke execute on function public.syntrix_auth_revoke_session(text) from service_role;
revoke execute on function public.syntrix_auth_cleanup(integer) from service_role;

-- Re-enable with the corresponding GRANT statements in phase2_auth_migration.sql
-- after the application has been configured and the objects have been reviewed.
