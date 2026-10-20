-- System context belongs to the worker, step 2 (#376; step 1 is 0028, #271). `app.system = on` now
-- counts only in a session logged in as fiscus_worker: SQL injected into the api, which logs in as
-- fiscus_app, can no longer claim to be a worker job. session_user is the login role, which neither
-- SET ROLE nor SECURITY DEFINER changes.
-- Contract: 0.2.0's api uses system context as fiscus_app (0.3.0's doesn't), so rolling back past
-- 0.3.0 from here means restoring the pre-upgrade backup (docs/design/upgrades.md §6).
CREATE OR REPLACE FUNCTION fiscus_is_system() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT session_user = 'fiscus_worker' AND current_setting('app.system', true) = 'on' $$;
