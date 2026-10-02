-- Database roles (docs/design/data-model.md §4.1). The migrate job connects as the schema
-- owner. Services use fiscus_app (RLS enforced); fiscus_maintenance bypasses RLS for an
-- allow-listed set of jobs. Both start NOLOGIN; `migrate` enables login when a password is set.
-- Creating a BYPASSRLS role requires the first migration to run as a superuser.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fiscus_app') THEN
    CREATE ROLE fiscus_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fiscus_maintenance') THEN
    CREATE ROLE fiscus_maintenance NOLOGIN BYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO fiscus_app, fiscus_maintenance', current_database());
END
$$;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO fiscus_app, fiscus_maintenance;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fiscus_app, fiscus_maintenance;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO fiscus_app, fiscus_maintenance;
