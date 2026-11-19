-- Plaid webhooks (#84, ADR 0008 §Sync 2). A webhook comes with no session: no member, so no
-- household context the api could use, and the api never enters system context (#271). What it
-- needs is done by a few definers, each narrow: find the Item's connection by Plaid's item id,
-- read that Item's credential set (its secret still encrypted with the household key), ask the
-- runner for a sync or a check, and count the outcome. The worker moves Items to a new webhook URL
-- and relaxes polling while webhooks are healthy.

-- The counts: instance-level, written only through fiscus_record_plaid_webhook (as with
-- instance_settings, 0035, fiscus_app may only read them, and the worker is a member of it).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON plaid_webhook_stats FROM fiscus_app, fiscus_maintenance;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON plaid_webhook_stats TO fiscus_steward;
--> statement-breakpoint
GRANT UPDATE (count, last_at) ON plaid_webhook_stats TO fiscus_steward;
--> statement-breakpoint
GRANT UPDATE (sync_requested_at, check_requested_at, webhook_enabled) ON connections TO fiscus_steward;
--> statement-breakpoint
GRANT SELECT (id, household_id, client_id, env, secret_enc) ON aggregation_credentials
  TO fiscus_steward;
--> statement-breakpoint

-- The connection a webhook's item id names, as ids only: the household, the connection, and the
-- credential set it was made with (null = the server's keys). A Plaid connection that isn't
-- disconnected, in an active household. Nothing for the worker, which has no use for it.
CREATE FUNCTION fiscus_find_plaid_item(p_item_id text)
  RETURNS TABLE (household_id uuid, connection_id uuid, credential_set_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT c.household_id, c.id, c.credential_set_id
    FROM connections c JOIN households h ON h.id = c.household_id
    WHERE session_user <> 'fiscus_worker'
      AND c.provider = 'plaid' AND c.provider_item_id = p_item_id
      AND c.status <> 'disconnected' AND h.status = 'active'
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_find_plaid_item(text) OWNER TO fiscus_steward;
--> statement-breakpoint

-- The household key set an Item was made with, for checking its webhook with that set's own keys
-- (ADR 0008 §Credentials 4): the client id, the environment, and the secret as stored, encrypted
-- with the household key and bound to its row. Only the set a live connection with that item id
-- names; nothing for the server's keys, which the api has.
CREATE FUNCTION fiscus_plaid_webhook_key_set(p_item_id text)
  RETURNS TABLE (credential_set_id uuid, household_id uuid, client_id text, env text, secret_enc bytea)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT a.id, a.household_id, a.client_id, a.env, a.secret_enc
    FROM connections c
    JOIN households h ON h.id = c.household_id
    JOIN aggregation_credentials a ON a.household_id = c.household_id AND a.id = c.credential_set_id
    WHERE session_user <> 'fiscus_worker'
      AND c.provider = 'plaid' AND c.provider_item_id = p_item_id
      AND c.status <> 'disconnected' AND h.status = 'active'
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_plaid_webhook_key_set(text) OWNER TO fiscus_steward;
--> statement-breakpoint

-- What a verified webhook asks of the runner, by connection id. Scheduling columns only:
-- - 'sync': new data is ready. For `ok` and `error`; repeats before the sync merge into one.
-- - 'check': the Item changed. For `ok`, `error` and `login_required` (a login fixed at the bank).
--   The runner asks Plaid before changing anything: the webhook itself is never trusted.
-- - 'acknowledged': Plaid confirmed the Item's webhook URL, which is this server's current one
--   (p_url) only if that's the URL the Item was moved to.
-- Returns whether anything was queued.
CREATE FUNCTION fiscus_queue_plaid_webhook(p_connection uuid, p_action text, p_url text)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF p_action = 'sync' THEN
    UPDATE connections c SET sync_requested_at = coalesce(c.sync_requested_at, now())
    WHERE c.id = p_connection AND c.provider = 'plaid' AND c.status IN ('ok', 'error');
  ELSIF p_action = 'check' THEN
    UPDATE connections c SET check_requested_at = coalesce(c.check_requested_at, now())
    WHERE c.id = p_connection AND c.provider = 'plaid' AND c.status IN ('ok', 'error', 'login_required');
  ELSIF p_action = 'acknowledged' THEN
    UPDATE connections c SET webhook_enabled = true
    WHERE c.id = p_connection AND c.provider = 'plaid' AND c.webhook_url = p_url
      AND p_url IS NOT NULL;
  ELSE
    RAISE EXCEPTION 'fiscus_queue_plaid_webhook: unknown action';
  END IF;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_queue_plaid_webhook(uuid, text, text) OWNER TO fiscus_steward;
--> statement-breakpoint

-- Counts one request to the receiver, in this hour's bucket for its credential set and outcome,
-- and lets buckets older than 8 days go. The outcome is checked by the table.
CREATE FUNCTION fiscus_record_plaid_webhook(p_credential_set uuid, p_outcome text)
  RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_hour timestamptz := date_trunc('hour', now());
BEGIN
  INSERT INTO plaid_webhook_stats AS s (hour, credential_set_id, outcome, count, last_at)
    VALUES (v_hour, p_credential_set, p_outcome, 1, now())
    ON CONFLICT ON CONSTRAINT plaid_webhook_stats_bucket
      DO UPDATE SET count = s.count + 1, last_at = EXCLUDED.last_at;
  DELETE FROM plaid_webhook_stats WHERE hour < now() - interval '8 days';
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_record_plaid_webhook(uuid, text) OWNER TO fiscus_steward;
--> statement-breakpoint

-- The runner's claim, as in 0037, plus what webhooks asked for: a requested sync is due at once
-- (for `ok` and `error`), and a requested check even while the connection needs signing in again,
-- since the check is how a login fixed at the bank is noticed.
CREATE OR REPLACE FUNCTION fiscus_claim_due_connections(p_limit integer, p_lease interval)
  RETURNS TABLE (connection_id uuid, household_id uuid)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    WITH due AS (
      SELECT c.id FROM connections c JOIN households h ON h.id = c.household_id
      WHERE session_user = 'fiscus_worker'
        AND (c.lease_until IS NULL OR c.lease_until <= now())
        AND (
          (c.next_sync_at <= now()
            AND (c.status IN ('ok', 'error') OR (c.status = 'disconnected' AND c.disconnect_requested)))
          OR (c.sync_requested_at IS NOT NULL AND c.status IN ('ok', 'error'))
          OR (c.check_requested_at IS NOT NULL AND c.status IN ('ok', 'error', 'login_required'))
        )
        AND h.status = 'active'
      ORDER BY least(c.check_requested_at, c.sync_requested_at, c.next_sync_at)
      LIMIT least(greatest(p_limit, 0), 1000)
      FOR UPDATE OF c SKIP LOCKED
    )
    UPDATE connections c SET lease_until = now() + greatest(p_lease, interval '0')
    FROM due WHERE c.id = due.id
    RETURNING c.id, c.household_id
  $$;
--> statement-breakpoint

-- Plaid connections whose Item's webhook URL isn't p_url (null: webhooks are off, so none), for
-- the worker to move with /item/webhook/update, household-key Items included. Not disconnected
-- ones, nor one whose move failed in the last hour. Ids only; only for the worker.
CREATE FUNCTION fiscus_plaid_webhook_moves(p_url text, p_limit integer)
  RETURNS TABLE (connection_id uuid, household_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT c.id, c.household_id FROM connections c JOIN households h ON h.id = c.household_id
    WHERE session_user = 'fiscus_worker'
      AND c.provider = 'plaid' AND c.status <> 'disconnected' AND h.status = 'active'
      AND c.webhook_url IS DISTINCT FROM p_url
      AND (c.webhook_move_failed_at IS NULL OR c.webhook_move_failed_at <= now() - interval '1 hour')
    ORDER BY c.created_at
    LIMIT least(greatest(p_limit, 0), 1000)
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_plaid_webhook_moves(text, integer) OWNER TO fiscus_steward;
--> statement-breakpoint

-- While webhooks aren't healthy, polling is back to normal: a Plaid connection scheduled further
-- out than p_interval after its last sync (it was relaxed) is brought back to then, or now. Only
-- the worker; returns how many.
CREATE FUNCTION fiscus_unrelax_connections(p_interval interval) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_count integer;
BEGIN
  IF session_user <> 'fiscus_worker' THEN
    RAISE EXCEPTION 'fiscus_unrelax_connections is the worker''s';
  END IF;
  UPDATE connections c
    SET next_sync_at = greatest(now(), c.last_synced_at + p_interval)
    WHERE c.provider = 'plaid' AND c.status IN ('ok', 'error') AND c.last_synced_at IS NOT NULL
      AND c.next_sync_at > c.last_synced_at + p_interval * 1.2
      AND (c.lease_until IS NULL OR c.lease_until <= now());
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_unrelax_connections(interval) OWNER TO fiscus_steward;
