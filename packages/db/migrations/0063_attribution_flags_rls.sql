-- attribution_flags (#60): seen with their transaction; raised by someone who can see it, as
-- themselves; resolved by the paying account's owners, or withdrawn by whoever raised it. Never
-- deleted by the app: a resolved flag stays as a record.
ALTER TABLE attribution_flags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE attribution_flags FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attribution_flags_select ON attribution_flags FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND (fiscus_is_system() OR transaction_id IN (SELECT id FROM transactions))
);
--> statement-breakpoint
CREATE POLICY attribution_flags_insert ON attribution_flags FOR INSERT WITH CHECK (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND flagged_by_member_id = fiscus_member()
  AND resolved_at IS NULL
  AND transaction_id IN (SELECT id FROM transactions)
);
--> statement-breakpoint
CREATE POLICY attribution_flags_update ON attribution_flags FOR UPDATE
  USING (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND resolved_at IS NULL
    AND (
      flagged_by_member_id = fiscus_member()
      OR transaction_id IN (
        SELECT t.id FROM transactions t
        WHERE t.account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner'))
    )
  )
  WITH CHECK (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND resolved_by_member_id = fiscus_member()
  );
--> statement-breakpoint
CREATE TRIGGER attribution_flags_mark_write AFTER INSERT OR UPDATE OR DELETE ON attribution_flags
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
