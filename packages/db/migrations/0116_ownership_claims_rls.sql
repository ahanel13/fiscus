-- ownership_claims (#267, ADR 0012 §Departures item 7, D35): everyone in the household sees an
-- open claim and how each ended, as the activity history already says. Each step has one person
-- who may take it, checked here for every role that writes:
-- - a member (not an owner or viewer) claims, as themselves, only while every owner has been away
--   from Fiscus for 30 days. The database sets the 30 days' notice, so nobody picks a shorter one;
-- - any current owner rejects it, and only the claimant withdraws it, while it's open;
-- - only the worker cancels it (an owner came back, or the claimant can't claim any more) or grants
--   it, and grants it only once the notice is over.
-- A claim that has ended never changes again, and nothing deletes one.
ALTER TABLE ownership_claims ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ownership_claims FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY ownership_claims_select ON ownership_claims FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
);
--> statement-breakpoint
CREATE POLICY ownership_claims_insert ON ownership_claims FOR INSERT
  WITH CHECK (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND claimant_member_id = fiscus_member() AND status = 'open'
  );
--> statement-breakpoint
CREATE POLICY ownership_claims_update ON ownership_claims FOR UPDATE
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint

CREATE FUNCTION fiscus_ownership_claim_steps() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF TG_OP = 'INSERT' THEN
      NEW.status := 'open';
      NEW.created_at := now();
      NEW.ends_at := now() + interval '30 days';
      NEW.closed_at := NULL;
      NEW.closed_by_member_id := NULL;
      NEW.cancel_reason := NULL;
      IF fiscus_is_system() OR NEW.claimant_member_id IS DISTINCT FROM fiscus_member()
         OR NOT EXISTS (
           SELECT 1 FROM household_members m
           WHERE m.id = NEW.claimant_member_id AND m.household_id = NEW.household_id
             AND m.left_at IS NULL AND m.role = 'member' AND m.user_id IS NOT NULL) THEN
        RAISE EXCEPTION 'Only a member who isn''t an owner or a viewer claims, as themselves'
          USING ERRCODE = '42501';
      END IF;
      IF EXISTS (
        SELECT 1 FROM household_members m JOIN users u ON u.id = m.user_id
        WHERE m.household_id = NEW.household_id AND m.left_at IS NULL AND m.role = 'owner'
          AND u.last_active_at > now() - interval '30 days') THEN
        RAISE EXCEPTION 'An owner has used Fiscus in the last 30 days'
          USING ERRCODE = '23514', CONSTRAINT = 'ownership_claims_owners_away';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD.status <> 'open' THEN
      RAISE EXCEPTION 'An ownership claim that has ended can''t change' USING ERRCODE = '23514';
    END IF;
    IF (NEW.id, NEW.household_id, NEW.claimant_member_id, NEW.created_at, NEW.ends_at)
       IS DISTINCT FROM (OLD.id, OLD.household_id, OLD.claimant_member_id, OLD.created_at,
                         OLD.ends_at) THEN
      RAISE EXCEPTION 'Only how an ownership claim ended changes' USING ERRCODE = '23514';
    END IF;
    NEW.closed_at := now();
    IF (NEW.status = 'rejected' AND NOT fiscus_is_system()
          AND NEW.closed_by_member_id = fiscus_member()
          AND EXISTS (
            SELECT 1 FROM household_members m
            WHERE m.id = fiscus_member() AND m.household_id = NEW.household_id
              AND m.left_at IS NULL AND m.role = 'owner'))
       OR (NEW.status = 'withdrawn' AND NOT fiscus_is_system()
          AND NEW.closed_by_member_id = fiscus_member()
          AND NEW.claimant_member_id = fiscus_member())
       OR (NEW.status = 'cancelled' AND fiscus_is_system() AND NEW.closed_by_member_id IS NULL)
       OR (NEW.status = 'granted' AND fiscus_is_system() AND NEW.closed_by_member_id IS NULL
          AND NEW.ends_at <= now()) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Not yours to end this way' USING ERRCODE = '42501';
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER ownership_claims_steps BEFORE INSERT OR UPDATE ON ownership_claims
  FOR EACH ROW EXECUTE FUNCTION fiscus_ownership_claim_steps();
--> statement-breakpoint
CREATE TRIGGER ownership_claims_mark_write AFTER INSERT OR UPDATE OR DELETE
  ON ownership_claims FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint

-- For the worker: active households with a claim open, or one that ended since p_since, so it can
-- tell the people involved, and cancel or grant what's due. Ids only, and only for a session
-- logged in as fiscus_worker; what it reads after that, it reads in the household's context.
CREATE FUNCTION fiscus_ownership_claim_households(p_since timestamptz)
  RETURNS TABLE (household_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT DISTINCT c.household_id FROM ownership_claims c JOIN households h ON h.id = c.household_id
    WHERE session_user = 'fiscus_worker' AND h.status = 'active'
      AND (c.status = 'open' OR c.closed_at > p_since)
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_ownership_claim_households(timestamptz) OWNER TO fiscus_steward;
--> statement-breakpoint
GRANT SELECT ON ownership_claims TO fiscus_steward;
