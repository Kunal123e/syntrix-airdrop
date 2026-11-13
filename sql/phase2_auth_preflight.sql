-- Read-only Phase 2 staging preflight. This script makes no changes.

select current_database() as database_name, current_user, current_schema();

select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin
  from pg_catalog.pg_roles
 where rolname in ('anon', 'authenticated', 'service_role')
 order by rolname;

select extname, extversion
  from pg_catalog.pg_extension
 where extname = 'pgcrypto';

select table_schema, table_name
  from information_schema.tables
 where table_schema = 'public'
   and (table_name like 'syntrix_auth_%'
        or table_name in ('users', 'upload_jobs', 'upload_batches'))
 order by table_name;

select n.nspname as schema_name,
       p.proname,
       pg_get_function_identity_arguments(p.oid) as identity_arguments,
       pg_get_function_result(p.oid) as return_type,
       p.prosecdef,
       p.proconfig
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and (p.proname like 'syntrix_auth_%'
        or p.proname like '%otp%'
        or p.proname like '%session%')
 order by p.proname, identity_arguments;

select n.nspname as schema_name,
       c.relname as object_name,
       c.relkind,
       c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as rls_forced
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and (c.relname like 'syntrix_auth_%' or c.relname = 'users')
 order by c.relname;

select schemaname, tablename, indexname, indexdef
  from pg_catalog.pg_indexes
 where schemaname = 'public'
   and (tablename like 'syntrix_auth_%' or tablename in ('users', 'upload_jobs', 'upload_batches'))
 order by tablename, indexname;

select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
  from pg_catalog.pg_policies
 where schemaname = 'public'
   and (tablename like 'syntrix_auth_%' or tablename = 'users')
 order by tablename, policyname;

select routine_schema, routine_name, privilege_type, grantee
  from information_schema.routine_privileges
 where routine_schema = 'public'
   and routine_name like 'syntrix_auth_%'
 order by routine_name, grantee, privilege_type;
