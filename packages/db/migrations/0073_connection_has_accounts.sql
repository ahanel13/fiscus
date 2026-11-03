-- Moving an account to another bank connection (Plaid to SimpleFIN or back): the one it left is
-- ended once it syncs nothing, so Plaid stops billing for it (ITEM-005). Its owner may not see
-- every account it syncs (they can set others as owners, privately), so whether any are left is
-- asked here. Only its owner gets an answer; anyone else gets null.
CREATE FUNCTION fiscus_connection_has_accounts(p_connection uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  SELECT CASE
    WHEN fiscus_context_valid() AND EXISTS (
      SELECT 1 FROM connections c
      WHERE c.id = p_connection AND c.household_id = fiscus_household()
        AND c.owner_member_id = fiscus_member()
    )
    THEN EXISTS (
      SELECT 1 FROM accounts a
      WHERE a.household_id = fiscus_household() AND a.connection_id = p_connection
    )
  END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_connection_has_accounts(uuid) OWNER TO fiscus_steward;
