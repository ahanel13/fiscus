-- consent_requests (#265, D34): everyone in the household sees who asked whom, and how it ended,
-- as the activity history already says. Only you ask, as yourself; only the person asked agrees
-- or declines, and only whoever asked withdraws, while it's open. Once its 14 days are over, only
-- the worker ends it, as expired. A request that has ended never changes again, and nothing
-- deletes one.
ALTER TABLE consent_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE consent_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY consent_requests_select ON consent_requests FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
);
--> statement-breakpoint
CREATE POLICY consent_requests_insert ON consent_requests FOR INSERT
  WITH CHECK (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND requested_by_member_id = fiscus_member() AND status = 'pending'
  );
--> statement-breakpoint
CREATE POLICY consent_requests_update ON consent_requests FOR UPDATE
  USING (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND (fiscus_is_system() OR fiscus_member() IN (member_id, requested_by_member_id))
  )
  WITH CHECK (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND (fiscus_is_system() OR fiscus_member() IN (member_id, requested_by_member_id))
  );
--> statement-breakpoint

-- Who may end a request, and how: the rules above, for every role that writes.
CREATE FUNCTION fiscus_consent_request_ends() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'A consent request that has ended can''t change' USING ERRCODE = '23514';
    END IF;
    IF (NEW.id, NEW.household_id, NEW.kind, NEW.requested_by_member_id, NEW.member_id,
        NEW.created_at, NEW.expires_at)
       IS DISTINCT FROM (OLD.id, OLD.household_id, OLD.kind, OLD.requested_by_member_id,
        OLD.member_id, OLD.created_at, OLD.expires_at) THEN
      RAISE EXCEPTION 'Only a consent request''s status changes' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'pending'
       OR (NEW.expires_at > now() AND (
             (NEW.status IN ('accepted', 'declined') AND NEW.member_id = fiscus_member())
             OR (NEW.status = 'withdrawn' AND NEW.requested_by_member_id = fiscus_member())))
       OR (NEW.status = 'expired' AND fiscus_is_system() AND NEW.expires_at <= now()) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Not yours to end this way' USING ERRCODE = '42501';
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER consent_requests_ends BEFORE UPDATE ON consent_requests
  FOR EACH ROW EXECUTE FUNCTION fiscus_consent_request_ends();
--> statement-breakpoint
CREATE TRIGGER consent_requests_mark_write AFTER INSERT OR UPDATE OR DELETE
  ON consent_requests FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint

-- For the worker: active households with a request still open, or one that ended since p_since,
-- so it can tell the people involved and expire what's due. Ids only, and only for a session
-- logged in as fiscus_worker; what it reads after that, it reads in the household's context.
CREATE FUNCTION fiscus_consent_request_households(p_since timestamptz)
  RETURNS TABLE (household_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT DISTINCT c.household_id FROM consent_requests c JOIN households h ON h.id = c.household_id
    WHERE session_user = 'fiscus_worker' AND h.status = 'active'
      AND (c.status = 'pending' OR c.closed_at > p_since)
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_consent_request_households(timestamptz) OWNER TO fiscus_steward;
--> statement-breakpoint
GRANT SELECT ON consent_requests TO fiscus_steward;
