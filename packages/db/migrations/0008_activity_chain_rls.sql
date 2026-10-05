-- Chain heads follow the same isolation as their events (ADR 0013): a household's head in its
-- own context; the instance chain (nil UUID) is shared by instance-level events, which have no
-- household. Appends need SELECT ... FOR UPDATE plus INSERT/UPDATE on the head row.
ALTER TABLE audit_chain_heads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_chain_heads FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_chain_heads_scope ON audit_chain_heads FOR ALL
  USING (
    (scope_id = fiscus_household() AND (SELECT fiscus_context_valid()))
    OR scope_id = '00000000-0000-0000-0000-000000000000'::uuid
  )
  WITH CHECK (
    (scope_id = fiscus_household() AND (SELECT fiscus_context_valid()))
    OR scope_id = '00000000-0000-0000-0000-000000000000'::uuid
  );
--> statement-breakpoint
-- Heads are bookkeeping, never deleted by the app.
REVOKE DELETE, TRUNCATE ON audit_chain_heads FROM fiscus_app;
--> statement-breakpoint
-- Write detection for "every household write records activity" (ADR 0013 §1): a row trigger
-- on each household table sets a transaction-local flag that HouseholdScope checks before commit.
-- Row-level (not statement-level), so statements that change nothing don't count.
CREATE FUNCTION fiscus_mark_household_write() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM set_config('fiscus.household_write', 'on', true);
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER households_mark_write AFTER INSERT OR UPDATE OR DELETE ON households
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint
CREATE TRIGGER household_members_mark_write AFTER INSERT OR UPDATE OR DELETE ON household_members
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint
CREATE TRIGGER invites_mark_write AFTER INSERT OR UPDATE OR DELETE ON invites
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint
CREATE TRIGGER household_keys_mark_write AFTER INSERT OR UPDATE OR DELETE ON household_keys
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
