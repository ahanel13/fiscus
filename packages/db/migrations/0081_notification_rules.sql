-- The notification rules (#127; bills walkthrough D18–D20): the worker evaluates each household's
-- rules in its own time zone, and looks for new transactions to tell people about. Both are lists
-- of ids, outside any household's context, only for a session logged in as fiscus_worker; anyone
-- else gets nothing. Not for a household that's disabled or being deleted. What the rules read
-- after that, they read in each member's own context.

-- Every active household, with its time zone.
CREATE FUNCTION fiscus_notification_households()
  RETURNS TABLE (household_id uuid, timezone text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT h.id, h.timezone FROM households h
    WHERE session_user = 'fiscus_worker' AND h.status = 'active'
    ORDER BY h.id
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_notification_households() OWNER TO fiscus_steward;
--> statement-breakpoint

-- Active households with transactions written since p_since (a sync, an import, one added by
-- hand): where a big transaction may have arrived.
CREATE FUNCTION fiscus_households_with_new_transactions(p_since timestamptz)
  RETURNS TABLE (household_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT DISTINCT t.household_id FROM transactions t JOIN households h ON h.id = t.household_id
    WHERE session_user = 'fiscus_worker' AND t.created_at > p_since AND h.status = 'active'
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_households_with_new_transactions(timestamptz) OWNER TO fiscus_steward;
--> statement-breakpoint
GRANT SELECT ON transactions TO fiscus_steward;
