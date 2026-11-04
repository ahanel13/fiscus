-- Goals (#131, goals walkthrough). The household's goals (member_id null) are everyone's; a
-- member's own is theirs alone, and no one else sees it or that it exists (G15). Claims and their
-- history follow their goal. Who may change the household's goals (owners and members, not
-- viewers) is the api's to enforce, as for budgets; who may claim an account is the policy's: its
-- owners (G7).
ALTER TABLE goals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE goals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY goals_household ON goals FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint
CREATE POLICY goals_member ON goals AS RESTRICTIVE FOR ALL
  USING (member_id IS NULL OR member_id = fiscus_member() OR (SELECT fiscus_is_system()))
  WITH CHECK (member_id IS NULL OR member_id = fiscus_member() OR (SELECT fiscus_is_system()));
--> statement-breakpoint
CREATE TRIGGER goals_mark_write AFTER INSERT OR UPDATE OR DELETE ON goals
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint

-- goal_claims: seen with their goal, which may show a claim on an account the viewer can't see
-- (only the claim: fiscus_goal_claim_values() never gives its balance). Set, changed and taken
-- off only by the account's owners.
ALTER TABLE goal_claims ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE goal_claims FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY goal_claims_household ON goal_claims FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint
CREATE POLICY goal_claims_goal ON goal_claims AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM goals g WHERE g.id = goal_id))
  WITH CHECK (EXISTS (SELECT 1 FROM goals g WHERE g.id = goal_id));
--> statement-breakpoint
CREATE POLICY goal_claims_owner_insert ON goal_claims AS RESTRICTIVE FOR INSERT
  WITH CHECK ((SELECT fiscus_is_system())
    OR account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner'));
--> statement-breakpoint
CREATE POLICY goal_claims_owner_update ON goal_claims AS RESTRICTIVE FOR UPDATE
  USING ((SELECT fiscus_is_system())
    OR account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner'))
  WITH CHECK ((SELECT fiscus_is_system())
    OR account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner'));
--> statement-breakpoint
CREATE POLICY goal_claims_owner_delete ON goal_claims AS RESTRICTIVE FOR DELETE
  USING ((SELECT fiscus_is_system())
    OR account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner'));
--> statement-breakpoint
CREATE TRIGGER goal_claims_mark_write AFTER INSERT OR UPDATE OR DELETE ON goal_claims
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint

-- goal_claim_events: a claim's history (G17), seen with its goal, added to and never changed.
ALTER TABLE goal_claim_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE goal_claim_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY goal_claim_events_select ON goal_claim_events FOR SELECT
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND EXISTS (SELECT 1 FROM goals g WHERE g.id = goal_id));
--> statement-breakpoint
CREATE POLICY goal_claim_events_insert ON goal_claim_events FOR INSERT
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND EXISTS (SELECT 1 FROM goals g WHERE g.id = goal_id));
--> statement-breakpoint
CREATE TRIGGER goal_claim_events_mark_write AFTER INSERT OR UPDATE OR DELETE ON goal_claim_events
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint

-- What a claim is worth needs the account's balance, which someone else's private account hides,
-- and what's free to claim needs every goal's claims, some of them someone else's own. These
-- read-only definer functions answer just that much.
GRANT SELECT ON goals, goal_claims, balance_snapshots TO fiscus_definer;
--> statement-breakpoint

-- Each claim on the goals the caller sees, with what it's worth: a fixed amount as it is; a
-- percentage of the balance, scaled down when fixed claims leave too little (G3). With the
-- account's name only when the caller sees the account, and its owners, for "Alex's account".
-- `short_minor` is how far the account falls below its fixed claims.
CREATE FUNCTION fiscus_goal_claim_values()
  RETURNS TABLE (claim_id uuid, goal_id uuid, account_id uuid, value_minor bigint,
                 short_minor bigint, account_name text, owner_ids uuid[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    WITH claims AS (
      SELECT c.id, c.goal_id, c.account_id, c.amount_minor, c.percent_bps,
        greatest(coalesce((SELECT s.balance_minor FROM balance_snapshots s
                           WHERE s.account_id = c.account_id
                           ORDER BY s.as_of DESC LIMIT 1), 0), 0) AS balance
      FROM goal_claims c
      WHERE c.household_id = fiscus_household() AND fiscus_context_valid()
    ), totals AS (
      SELECT account_id, max(balance) AS balance,
        coalesce(sum(amount_minor), 0) AS fixed,
        coalesce(sum(floor(balance * percent_bps / 10000.0)), 0) AS percent
      FROM claims GROUP BY account_id
    )
    SELECT c.id, c.goal_id, c.account_id,
      (CASE
        WHEN c.amount_minor IS NOT NULL THEN c.amount_minor
        WHEN t.percent = 0 THEN 0
        ELSE floor(least(1.0, greatest(t.balance - t.fixed, 0) / t.percent)
                   * floor(c.balance * c.percent_bps / 10000.0))
      END)::bigint,
      greatest(t.fixed - t.balance, 0)::bigint,
      (SELECT a.name FROM accounts a
       WHERE a.id = c.account_id
         AND a.id IN (SELECT x.account_id FROM fiscus_account_access() x)),
      (SELECT array_agg(o.member_id ORDER BY o.member_id) FROM account_owners o
       WHERE o.account_id = c.account_id)
    FROM claims c
    JOIN totals t ON t.account_id = c.account_id
    JOIN goals g ON g.id = c.goal_id
    WHERE g.member_id IS NULL OR g.member_id = fiscus_member()
      OR current_setting('app.system', true) = 'on'
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_goal_claim_values() OWNER TO fiscus_definer;
--> statement-breakpoint

-- An account the caller owns: its balance, and what every goal has claimed of it, theirs or not
-- (G3: claims never go beyond the balance). Nothing for an account they don't own.
CREATE FUNCTION fiscus_account_claimed(p_account uuid)
  RETURNS TABLE (balance_minor bigint, fixed_minor bigint, percent_bps integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT
      greatest(coalesce((SELECT s.balance_minor FROM balance_snapshots s
                         WHERE s.account_id = p_account
                         ORDER BY s.as_of DESC LIMIT 1), 0), 0)::bigint,
      coalesce((SELECT sum(c.amount_minor) FROM goal_claims c
                WHERE c.account_id = p_account), 0)::bigint,
      coalesce((SELECT sum(c.percent_bps) FROM goal_claims c
                WHERE c.account_id = p_account), 0)::integer
    WHERE fiscus_context_valid()
      AND p_account IN (SELECT x.account_id FROM fiscus_account_access() x
                        WHERE x.level = 'owner')
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_account_claimed(uuid) OWNER TO fiscus_definer;
--> statement-breakpoint

-- A member's own goals go when they leave (GOAL-07), as their budget does (0054): members leave by
-- left_at, so the foreign key's cascade never fires for them.
GRANT SELECT, DELETE ON goals TO fiscus_steward;
--> statement-breakpoint
CREATE FUNCTION fiscus_delete_member_goals() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  DELETE FROM goals WHERE household_id = NEW.household_id AND member_id = NEW.id;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_delete_member_goals() OWNER TO fiscus_steward;
--> statement-breakpoint
CREATE TRIGGER household_members_delete_goals AFTER UPDATE OF left_at ON household_members
  FOR EACH ROW WHEN (OLD.left_at IS NULL AND NEW.left_at IS NOT NULL)
  EXECUTE FUNCTION fiscus_delete_member_goals();
