-- Abandoned setups (#81): a connection still in `setup` after p_age (its owner never chose its
-- accounts) is disconnected, so the worker ends it at the provider (Plaid's /item/remove) and the
-- operator stops paying for it. It has no accounts yet (they're made when the setup is
-- confirmed), so nothing else changes. Scheduling bookkeeping across households, like the claim:
-- only for a session logged in as fiscus_worker; anyone else changes nothing. Returns how many.
CREATE FUNCTION fiscus_abandon_setups(p_age interval) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    WITH abandoned AS (
      UPDATE connections c
        SET status = 'disconnected', disconnect_requested = true, next_sync_at = now(),
            updated_at = now()
      WHERE session_user = 'fiscus_worker'
        AND c.status = 'setup'
        AND c.created_at <= now() - greatest(p_age, interval '1 hour')
      RETURNING c.id
    )
    SELECT count(*)::integer FROM abandoned
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_abandon_setups(interval) OWNER TO fiscus_steward;
