-- OOOhm's two database roles (ADR-0006, docs/deploy.md#database-roles).
--
--   owner (ooohm_owner)  owns the schema: every table, sequence, type and function. Migrations,
--                        the seed and the TimeOff import connect as it (DATABASE_ADMIN_URL).
--   app   (ooohm_app)    what the app, the cron route and the worker connect as (DATABASE_URL):
--                        SELECT, INSERT, UPDATE and DELETE on every table, no DDL, and only
--                        SELECT and INSERT on audit_log. Row-level security holds it to one
--                        company per transaction (ADR-0004); the `<table>_owner` policies the
--                        migrations make for whoever ran them are pointed at the owner here.
--
-- Idempotent. `pnpm db:roles` runs it (the compose `migrate` service does, before migrating),
-- and every `pnpm db:migrate` runs it again in grants-only mode as the owner, after the
-- migrations, so tables a migration adds or recreates get the same grants.
--
-- Settings, read with current_setting() so the file runs unchanged from psql, the Neon SQL
-- editor or `pnpm db:roles` (unset or empty means the default):
--
--   ooohm.owner_role      default ooohm_owner (grants-only mode: the current user)
--   ooohm.app_role        default ooohm_app
--   ooohm.owner_password  sets the owner's password when given
--   ooohm.app_password    sets the app role's password when given
--   ooohm.grants_only     on: refresh the app role's grants only, as the owner (no roles,
--                         passwords or ownership)
--
-- From psql, as a superuser or the database owner:
--   SET ooohm.app_password = '...';
--   \i deploy/db-roles.sql
DO $roles$
DECLARE
  grants_only boolean := coalesce(nullif(current_setting('ooohm.grants_only', true), ''), 'off')::boolean;
  owner_role text := coalesce(nullif(current_setting('ooohm.owner_role', true), ''), CASE WHEN grants_only THEN current_user::text ELSE 'ooohm_owner' END);
  app_role text := coalesce(nullif(current_setting('ooohm.app_role', true), ''), 'ooohm_app');
  owner_password text := nullif(current_setting('ooohm.owner_password', true), '');
  app_password text := nullif(current_setting('ooohm.app_password', true), '');
  app_oid oid;
  r record;
BEGIN
  IF owner_role = app_role THEN
    RAISE EXCEPTION 'The owner and app roles must be different roles (both are "%").', owner_role;
  END IF;

  IF NOT grants_only THEN
    -- The roles, created when missing. Neither can create roles or databases.
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = owner_role) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE', owner_role);
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = app_role) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', app_role);
    END IF;
    IF owner_password IS NOT NULL THEN
      EXECUTE format('ALTER ROLE %I PASSWORD %L', owner_role, owner_password);
    END IF;
    IF app_password IS NOT NULL THEN
      EXECUTE format('ALTER ROLE %I PASSWORD %L', app_role, app_password);
    END IF;
  END IF;

  SELECT oid INTO app_oid FROM pg_roles WHERE rolname = app_role;
  IF app_oid IS NULL THEN
    RAISE NOTICE 'The app role "%" does not exist; no grants were changed.', app_role;
    RETURN;
  END IF;

  -- An app role that bypasses these grants would make them pointless: refuse it.
  IF EXISTS (SELECT FROM pg_roles WHERE oid = app_oid AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)) THEN
    RAISE EXCEPTION 'The app role "%" is a superuser or can bypass row security, create roles or create databases. Use a plain role (docs/deploy.md#database-roles).', app_role;
  END IF;
  IF pg_has_role(app_role, 'pg_write_all_data', 'USAGE') THEN
    RAISE EXCEPTION 'The app role "%" can write every table (pg_write_all_data, which Neon console roles get through neon_superuser). Create it with SQL instead (docs/deploy.md#database-roles).', app_role;
  END IF;
  IF pg_has_role(app_role, owner_role, 'USAGE') THEN
    RAISE EXCEPTION 'The app role "%" has the owner role "%"''s privileges. Revoke the membership.', app_role, owner_role;
  END IF;

  IF NOT grants_only THEN
    -- The owner can create in public (PG 15+ gives PUBLIC no CREATE there) and owns drizzle's
    -- schema, which holds the migrations journal; the migrator's CREATE SCHEMA IF NOT EXISTS
    -- needs CREATE on the database even when the schema is there. Nobody else creates in public.
    EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO %I', current_database(), owner_role);
    EXECUTE format('GRANT USAGE, CREATE ON SCHEMA public TO %I', owner_role);
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION %I', owner_role);
    IF (SELECT nspowner FROM pg_namespace WHERE nspname = 'drizzle') <> (SELECT oid FROM pg_roles WHERE rolname = owner_role) THEN
      EXECUTE format('ALTER SCHEMA drizzle OWNER TO %I', owner_role);
    END IF;

    -- Hand everything an earlier install created (as another role) to the owner. Tables
    -- first: their identity and serial sequences follow them.
    FOR r IN
      SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'drizzle') AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = owner_role)
        AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
    LOOP
      EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', r.nspname, r.relname, owner_role);
    END LOOP;
    FOR r IN
      SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'drizzle') AND c.relkind = 'S'
        AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = owner_role)
        AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i', 'e'))
    LOOP
      EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO %I', r.nspname, r.relname, owner_role);
    END LOOP;
    FOR r IN
      SELECT t.oid FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'r', 'm')
        AND t.typowner <> (SELECT oid FROM pg_roles WHERE rolname = owner_role)
        AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')
    LOOP
      EXECUTE format('ALTER TYPE %s OWNER TO %I', r.oid::regtype, owner_role);
    END LOOP;
    FOR r IN
      SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proowner <> (SELECT oid FROM pg_roles WHERE rolname = owner_role)
        AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    LOOP
      EXECUTE format('ALTER ROUTINE %s OWNER TO %I', r.oid::regprocedure, owner_role);
    END LOOP;

    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), app_role);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', app_role);
  END IF;

  -- Row-level security (drizzle/0031): each tenant table's `<table>_owner` policy lets its
  -- owner see every row. A migration names the role that ran it; point them at the owner,
  -- in case another role migrated before the tables were handed over.
  FOR r IN
    SELECT p.schemaname, p.tablename, p.policyname FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.policyname = p.tablename || '_owner' AND p.roles <> ARRAY[owner_role]::name[]
  LOOP
    EXECUTE format('ALTER POLICY %I ON %I.%I TO %I', r.policyname, r.schemaname, r.tablename, owner_role);
  END LOOP;

  -- What the app role may do today: rows on every table, but the audit log only grows.
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', app_role);
  IF to_regclass('public.audit_log') IS NOT NULL THEN
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.audit_log FROM %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT ON public.audit_log TO %I', app_role);
  END IF;
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', app_role);
  -- Views: a view reads its tables as its owner, past row security, unless it is
  -- security_invoker (a materialized view always does). The app role gets no rights on one
  -- that reads as its owner, and writes through none (ADR-0004).
  FOR r IN
    SELECT c.oid::regclass AS rel,
           coalesce((SELECT o.option_value::boolean FROM pg_options_to_table(c.reloptions) o WHERE o.option_name = 'security_invoker'), false) AS invoker
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
  LOOP
    IF r.invoker THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %s FROM %I', r.rel, app_role);
    ELSE
      EXECUTE format('REVOKE ALL ON %s FROM %I', r.rel, app_role);
    END IF;
  END LOOP;
  -- Functions run only for the roles granted them; the audit erasure functions are the app's
  -- one way to remove or redact audit rows (Admin -> People -> Delete).
  REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
  EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', app_role);

  -- And what it may do on whatever the owner creates later.
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', owner_role, app_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', owner_role, app_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC', owner_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I', owner_role, app_role);
END
$roles$;
