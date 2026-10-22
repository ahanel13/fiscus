-- Finishing a job the worker claimed with fiscus_claim_due_connections (#81): when the connection
-- is next due, and how its last run went. Scheduling bookkeeping, not a change anyone made, so it
-- isn't recorded as activity, and it runs outside any household's context, as the claim does: a
-- definer that changes the timing and status columns only, by id. Household data the jobs write
-- (deleting a secret, clearing disconnect_requested) goes through system context and records
-- activity as usual.
GRANT UPDATE (last_error_code, first_failed_at, last_synced_at, consecutive_failures) ON connections
  TO fiscus_steward;
--> statement-breakpoint

-- Only for a session logged in as fiscus_worker, and only for a connection a worker has leased.
-- p_outcome:
-- - 'synced': it worked. Back to `ok` (from `ok` or `error`), the failures cleared, next due in
--   p_next; due now instead if it was disconnected meanwhile, so the provider hears of it soon.
-- - 'failed': p_status (`error`, or `login_required` when only its owner signing in fixes it, D11)
--   for a connection that was `ok` or `error`; a disconnected one stays so. p_error_code is a code
--   (the provider's, or the worker's own such as `provider_unavailable`), never a message. The run
--   of failures begins now unless it already had, and it's next due in p_next (the backoff).
-- - 'done': nothing more to do (ended at the provider): never due again. Only once
--   disconnect_requested is cleared, so a job can't drop a removal that's still owed.
-- - 'released': the lease only, unfinished (shutting down); still due when it was.
-- Returns whether the connection was found leased.
CREATE FUNCTION fiscus_finish_connection_job(
  p_connection uuid,
  p_outcome text,
  p_next interval DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_error_code text DEFAULT NULL
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_next timestamptz := now() + least(greatest(coalesce(p_next, interval '0'), interval '0'),
                                      interval '2 days');
BEGIN
  IF session_user <> 'fiscus_worker' THEN
    RAISE EXCEPTION 'fiscus_finish_connection_job is the worker''s';
  END IF;
  IF p_outcome = 'synced' THEN
    UPDATE connections c SET
      status = CASE WHEN c.status IN ('ok', 'error') THEN 'ok' ELSE c.status END,
      last_error_code = NULL, first_failed_at = NULL, consecutive_failures = 0,
      last_synced_at = now(),
      next_sync_at = CASE WHEN c.status = 'disconnected' AND c.disconnect_requested THEN now()
                          ELSE v_next END,
      lease_until = NULL
    WHERE c.id = p_connection AND c.lease_until IS NOT NULL;
  ELSIF p_outcome = 'failed' THEN
    IF p_status IS NULL OR p_status NOT IN ('error', 'login_required') THEN
      RAISE EXCEPTION 'fiscus_finish_connection_job: a failure leaves it in error or login_required';
    END IF;
    IF p_error_code IS NULL OR p_error_code !~ '^[A-Za-z0-9_.:-]{1,64}$' THEN
      RAISE EXCEPTION 'fiscus_finish_connection_job: a failure needs an error code';
    END IF;
    UPDATE connections c SET
      status = CASE WHEN c.status IN ('ok', 'error') THEN p_status ELSE c.status END,
      last_error_code = p_error_code,
      first_failed_at = coalesce(c.first_failed_at, now()),
      consecutive_failures = c.consecutive_failures + 1,
      next_sync_at = v_next,
      lease_until = NULL
    WHERE c.id = p_connection AND c.lease_until IS NOT NULL;
  ELSIF p_outcome = 'done' THEN
    UPDATE connections c SET
      last_error_code = NULL, first_failed_at = NULL, consecutive_failures = 0,
      next_sync_at = NULL, lease_until = NULL
    WHERE c.id = p_connection AND c.lease_until IS NOT NULL
      AND c.status = 'disconnected' AND NOT c.disconnect_requested;
  ELSIF p_outcome = 'released' THEN
    UPDATE connections c SET lease_until = NULL
    WHERE c.id = p_connection AND c.lease_until IS NOT NULL;
  ELSE
    RAISE EXCEPTION 'fiscus_finish_connection_job: unknown outcome';
  END IF;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_finish_connection_job(uuid, text, interval, text, text) OWNER TO fiscus_steward;
