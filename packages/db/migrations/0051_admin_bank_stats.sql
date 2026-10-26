-- Server → Bank connections (#400, walkthrough §8): counts of connections across the instance, for
-- an instance admin. Connections are household data under row-level security, and the api never
-- enters system context (#271), so fiscus_admin_bank_stats() reads them as fiscus_definer, after
-- checking that the context's user is an instance admin outside any household. It returns
-- aggregates only (D16): no household, institution, account or connection is named or identified.
-- Disconnected connections are left out: they no longer reach a bank.
GRANT SELECT (household_id, provider, credential_set_id, status, last_synced_at,
  consecutive_failures) ON connections TO fiscus_definer;
--> statement-breakpoint
GRANT SELECT (id, is_instance_admin, disabled_at) ON users TO fiscus_definer;
--> statement-breakpoint

-- The scheduler syncs each connection on its own timetable rather than in runs, so "the last run"
-- is the last 24 hours: connections that synced in them, and connections whose latest sync failed.
CREATE FUNCTION fiscus_admin_bank_stats() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF session_user = 'fiscus_worker' OR fiscus_household() IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = fiscus_user() AND u.is_instance_admin AND u.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'fiscus_admin_bank_stats needs an instance admin in context';
  END IF;
  RETURN (
    WITH live AS (
      SELECT household_id, provider, credential_set_id, status, last_synced_at, consecutive_failures
      FROM connections WHERE status <> 'disconnected'
    )
    SELECT jsonb_build_object(
      'plaidInstanceKeys', jsonb_build_object(
        'households', count(DISTINCT household_id)
          FILTER (WHERE provider = 'plaid' AND credential_set_id IS NULL),
        'connections', count(*) FILTER (WHERE provider = 'plaid' AND credential_set_id IS NULL)),
      'plaidHouseholdKeys', jsonb_build_object(
        'households', count(DISTINCT household_id)
          FILTER (WHERE provider = 'plaid' AND credential_set_id IS NOT NULL),
        'connections', count(*) FILTER (WHERE provider = 'plaid' AND credential_set_id IS NOT NULL)),
      'simplefin', jsonb_build_object(
        'households', count(DISTINCT household_id) FILTER (WHERE provider = 'simplefin'),
        'connections', count(*) FILTER (WHERE provider = 'simplefin')),
      'byStatus', jsonb_build_object(
        'setup', count(*) FILTER (WHERE status = 'setup'),
        'ok', count(*) FILTER (WHERE status = 'ok'),
        'login_required', count(*) FILTER (WHERE status = 'login_required'),
        'error', count(*) FILTER (WHERE status = 'error')),
      'last24h', jsonb_build_object(
        'synced', count(*) FILTER (WHERE last_synced_at > now() - interval '24 hours'),
        'failing', count(*) FILTER (WHERE consecutive_failures > 0),
        'lastSyncedAt', max(last_synced_at))
    )
    FROM live
  );
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_admin_bank_stats() OWNER TO fiscus_definer;
