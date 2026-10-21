-- Bank connections (#78, the bank connections walkthrough D4, D11, D14; permissions ACC-02/03).
-- institutions is global reference data, like currencies: no household, no row-level security.

-- connections: visible to its owner, and to anyone who sees at least one of its accounts (ACC-02),
-- except while it's being set up, when only its owner sees it (D4: who sees it is settled before
-- anything syncs). Only its owner, or the worker, changes it.
ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY connections_select ON connections FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND (
    fiscus_is_system()
    OR owner_member_id = fiscus_member()
    OR (status <> 'setup' AND id IN (
      SELECT a.connection_id FROM accounts a
      WHERE a.id IN (SELECT account_id FROM fiscus_account_access())
    ))
  )
);
--> statement-breakpoint
CREATE POLICY connections_insert ON connections FOR INSERT WITH CHECK (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND (fiscus_is_system() OR owner_member_id = fiscus_member())
);
--> statement-breakpoint
CREATE POLICY connections_update ON connections FOR UPDATE
  USING (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND (fiscus_is_system() OR owner_member_id = fiscus_member())
  )
  WITH CHECK (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND (fiscus_is_system() OR owner_member_id = fiscus_member())
  );
--> statement-breakpoint
CREATE POLICY connections_delete ON connections FOR DELETE USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND (fiscus_is_system() OR owner_member_id = fiscus_member())
);
--> statement-breakpoint
CREATE TRIGGER connections_mark_write AFTER INSERT OR UPDATE OR DELETE ON connections
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint

-- connection_secrets: the connection's owner and the worker only. Other members, household owners
-- included, can't read even the ciphertext.
ALTER TABLE connection_secrets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE connection_secrets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY connection_secrets_owner ON connection_secrets FOR ALL
  USING (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND (fiscus_is_system() OR connection_id IN (
      SELECT c.id FROM connections c WHERE c.owner_member_id = fiscus_member()
    ))
  )
  WITH CHECK (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND (fiscus_is_system() OR connection_id IN (
      SELECT c.id FROM connections c WHERE c.owner_member_id = fiscus_member()
    ))
  );
--> statement-breakpoint
CREATE TRIGGER connection_secrets_mark_write AFTER INSERT OR UPDATE OR DELETE ON connection_secrets
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint

-- aggregation_credentials (schema only until #83): read within the household, since linking a
-- bank with the household's keys needs them (the api never returns the secret, HH-08); changed by
-- household owners or the worker. #83 may narrow this.
ALTER TABLE aggregation_credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE aggregation_credentials FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY aggregation_credentials_select ON aggregation_credentials FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
);
--> statement-breakpoint
CREATE POLICY aggregation_credentials_write ON aggregation_credentials FOR ALL
  USING (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND (fiscus_is_system() OR EXISTS (
      SELECT 1 FROM household_members m WHERE m.id = fiscus_member() AND m.role = 'owner'
    ))
  )
  WITH CHECK (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND (fiscus_is_system() OR EXISTS (
      SELECT 1 FROM household_members m WHERE m.id = fiscus_member() AND m.role = 'owner'
    ))
  );
--> statement-breakpoint
CREATE TRIGGER aggregation_credentials_mark_write AFTER INSERT OR UPDATE OR DELETE ON aggregation_credentials
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint

GRANT SELECT ON connections, accounts TO fiscus_steward;
--> statement-breakpoint
GRANT UPDATE (status, disconnect_requested, next_sync_at, lease_until, updated_at) ON connections
  TO fiscus_steward;
--> statement-breakpoint
GRANT UPDATE (connection_id, updated_at) ON accounts TO fiscus_steward;
--> statement-breakpoint

-- The worker's queue: up to p_limit connections that are due, leased for p_lease, as ids only
-- (the worker then reads each in its household's system context). Only for a session logged in as
-- fiscus_worker; anyone else gets nothing. SKIP LOCKED, so concurrent workers never claim the same
-- connection. Polled: `ok`, and `error` (backing off through next_sync_at); and disconnected ones
-- the worker still has to end at the provider. Never `setup` (D4) or `login_required`, which only
-- their owner signing in again fixes (D11), nor a household that's disabled or being deleted.
CREATE FUNCTION fiscus_claim_due_connections(p_limit integer, p_lease interval)
  RETURNS TABLE (connection_id uuid, household_id uuid)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    WITH due AS (
      SELECT c.id FROM connections c JOIN households h ON h.id = c.household_id
      WHERE session_user = 'fiscus_worker'
        AND c.next_sync_at <= now()
        AND (c.lease_until IS NULL OR c.lease_until <= now())
        AND (c.status IN ('ok', 'error') OR (c.status = 'disconnected' AND c.disconnect_requested))
        AND h.status = 'active'
      ORDER BY c.next_sync_at
      LIMIT least(greatest(p_limit, 0), 1000)
      FOR UPDATE OF c SKIP LOCKED
    )
    UPDATE connections c SET lease_until = now() + greatest(p_lease, interval '0')
    FROM due WHERE c.id = due.id
    RETURNING c.id, c.household_id
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_claim_due_connections(integer, interval) OWNER TO fiscus_steward;
--> statement-breakpoint

-- Disconnecting (D14, ACC-03): by the connection's owner, or by a household owner once its owner
-- has left. It stops syncing and its accounts let go of it, keeping their history and
-- provider_account_id (so reconnecting can suggest linking them back), including accounts the
-- caller doesn't own. The worker then ends it at the provider and deletes its secret
-- (disconnect_requested). Returns the accounts it let go of.
CREATE FUNCTION fiscus_disconnect_connection(p_connection uuid) RETURNS uuid[]
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_owner uuid;
  v_owner_left boolean;
  v_accounts uuid[];
BEGIN
  SELECT c.owner_member_id, m.left_at IS NOT NULL INTO v_owner, v_owner_left
    FROM connections c JOIN household_members m ON m.id = c.owner_member_id
    WHERE c.id = p_connection AND c.household_id = fiscus_household()
    FOR UPDATE OF c;
  IF NOT FOUND OR NOT fiscus_context_valid() THEN
    RAISE EXCEPTION 'fiscus_disconnect_connection: no such connection in this household';
  END IF;
  IF NOT (
    fiscus_is_system()
    OR EXISTS (
      SELECT 1 FROM household_members m
      WHERE m.id = fiscus_member()
        AND ((m.id = v_owner AND m.role IN ('owner', 'member')) OR (v_owner_left AND m.role = 'owner'))
    )
  ) THEN
    RAISE EXCEPTION 'fiscus_disconnect_connection needs its owner, or a household owner once they have left';
  END IF;
  UPDATE connections
    SET status = 'disconnected', disconnect_requested = true, next_sync_at = now(), updated_at = now()
    WHERE id = p_connection;
  WITH released AS (
    UPDATE accounts a SET connection_id = NULL, updated_at = now()
    WHERE a.household_id = fiscus_household() AND a.connection_id = p_connection
    RETURNING a.id
  )
  SELECT coalesce(array_agg(released.id), '{}') INTO v_accounts FROM released;
  RETURN v_accounts;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_disconnect_connection(uuid) OWNER TO fiscus_steward;
