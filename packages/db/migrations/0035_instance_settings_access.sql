-- Instance settings (#400) are instance-level, so no household row-level security. The api reads
-- them, and so will the worker, which logs in as fiscus_worker, a member of fiscus_app: whatever
-- fiscus_app may do, the worker may too. So fiscus_app may only read the table, and an instance
-- admin changes a setting through fiscus_set_instance_setting(), which checks that the context's
-- user is one. As with RLS, this guards against logic bugs (a worker job, or an api path that
-- isn't the admin endpoint, writing a setting); parameterized queries remain the defense against
-- injection (0028).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON instance_settings FROM fiscus_app, fiscus_maintenance;
--> statement-breakpoint
GRANT SELECT, INSERT ON instance_settings TO fiscus_steward;
--> statement-breakpoint
GRANT UPDATE (value, updated_at, updated_by_user_id) ON instance_settings TO fiscus_steward;
--> statement-breakpoint
GRANT SELECT (is_instance_admin, disabled_at) ON users TO fiscus_steward;
--> statement-breakpoint

-- Sets one setting for the context's user, an instance admin outside any household, and returns
-- what it was before (null when it was the default), for the audit entry. Settings are validated
-- against the registry in @fiscus/shared before this is called: the database doesn't know them.
CREATE FUNCTION fiscus_set_instance_setting(p_key text, p_value jsonb) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_old jsonb;
BEGIN
  IF session_user = 'fiscus_worker' OR fiscus_household() IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = fiscus_user() AND u.is_instance_admin AND u.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'fiscus_set_instance_setting needs an instance admin in context';
  END IF;
  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    RAISE EXCEPTION 'fiscus_set_instance_setting: a setting needs a value';
  END IF;
  -- Two admins changing the same setting at once: the second sees the first's value as before.
  PERFORM pg_advisory_xact_lock(hashtext('fiscus_instance_settings'), hashtext(p_key));
  SELECT s.value INTO v_old FROM instance_settings s WHERE s.key = p_key;
  INSERT INTO instance_settings (key, value, updated_at, updated_by_user_id)
    VALUES (p_key, p_value, now(), fiscus_user())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at,
          updated_by_user_id = EXCLUDED.updated_by_user_id;
  RETURN v_old;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_set_instance_setting(text, jsonb) OWNER TO fiscus_steward;
