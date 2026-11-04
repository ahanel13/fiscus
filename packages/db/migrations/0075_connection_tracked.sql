-- Choosing a live connection's accounts again: which of the bank's accounts it tracks already,
-- by the provider's ids. Its owner may not see them all (they can set others as owners, privately),
-- and one they can't see must still show as tracked, not as an account to add twice. Only its owner
-- gets an answer; anyone else gets nothing.
CREATE FUNCTION fiscus_connection_tracked(p_connection uuid) RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  SELECT a.provider_account_id FROM accounts a
  WHERE fiscus_context_valid()
    AND a.household_id = fiscus_household() AND a.connection_id = p_connection
    AND a.provider_account_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM connections c
      WHERE c.id = p_connection AND c.household_id = fiscus_household()
        AND c.owner_member_id = fiscus_member()
    )
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_connection_tracked(uuid) OWNER TO fiscus_steward;
