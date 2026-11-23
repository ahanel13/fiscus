-- member_moves (#253, ADR 0012 step 3, D37): seen only in the household it moves into, where the
-- person moving is the only member at first. Nothing in the household they leave shows it
-- (ADR 0012 §Departures item 10). The api only starts one, as the new household's owner, for a
-- membership of their own; only the worker changes it, as fiscus_maintenance.
ALTER TABLE member_moves ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE member_moves FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Is p_member, in p_household, a current membership of the context's user, in an active household
-- other than the context's? Read-only, so the insert policy below can check a row it can't see.
CREATE FUNCTION fiscus_can_move_out(p_household uuid, p_member uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM household_members m JOIN households h ON h.id = m.household_id
      WHERE m.id = p_member AND m.household_id = p_household
        AND m.left_at IS NULL AND m.user_id IS NOT NULL AND m.user_id = fiscus_user()
        AND h.status = 'active' AND p_household IS DISTINCT FROM fiscus_household()
    )
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_can_move_out(uuid, uuid) OWNER TO fiscus_definer;
--> statement-breakpoint

CREATE POLICY member_moves_select ON member_moves FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
);
--> statement-breakpoint
CREATE POLICY member_moves_insert ON member_moves FOR INSERT WITH CHECK (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND member_id = fiscus_member() AND status = 'pending' AND step = 0 AND plan IS NULL
  AND attempts = 0 AND lease_until IS NULL
  AND fiscus_can_move_out(from_household_id, from_member_id)
);
--> statement-breakpoint
CREATE TRIGGER member_moves_mark_write AFTER INSERT OR UPDATE OR DELETE ON member_moves
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint

-- For the worker: moves to carry on with, oldest first, leased for p_lease so two workers never
-- take the same one, and a lease that runs out (a worker stopped mid-step) frees it again. Ids
-- only, and only for a session logged in as fiscus_worker; anyone else gets nothing.
CREATE FUNCTION fiscus_claim_member_moves(p_limit integer, p_lease interval)
  RETURNS TABLE (move_id uuid, household_id uuid)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    WITH due AS (
      SELECT m.id FROM member_moves m
      WHERE session_user = 'fiscus_worker' AND m.status IN ('pending', 'moving')
        AND (m.lease_until IS NULL OR m.lease_until <= now())
      ORDER BY m.created_at
      LIMIT least(greatest(p_limit, 0), 100)
      FOR UPDATE OF m SKIP LOCKED
    )
    UPDATE member_moves m SET lease_until = now() + p_lease
    FROM due WHERE m.id = due.id
    RETURNING m.id, m.household_id
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_claim_member_moves(integer, interval) OWNER TO fiscus_steward;
--> statement-breakpoint
GRANT SELECT ON member_moves TO fiscus_steward;
--> statement-breakpoint
GRANT UPDATE (lease_until) ON member_moves TO fiscus_steward;
--> statement-breakpoint

-- For the household being left: whether the context's user, as p_member, is already moving out,
-- and into which household. Only for their own membership: nobody else learns of it.
CREATE FUNCTION fiscus_open_member_move(p_member uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT mm.household_id FROM member_moves mm
    JOIN household_members m ON m.id = mm.from_member_id
    WHERE mm.from_member_id = p_member AND mm.status IN ('pending', 'moving')
      AND m.user_id IS NOT NULL AND m.user_id = fiscus_user()
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_open_member_move(uuid) OWNER TO fiscus_definer;
--> statement-breakpoint
GRANT SELECT ON member_moves TO fiscus_definer;
