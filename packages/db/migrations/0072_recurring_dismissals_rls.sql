-- "Not recurring" (#119): payments someone said aren't a series. Visible to whoever sees the
-- account's transactions, as the series are (0068); said, and taken back, with owner or full access.
ALTER TABLE recurring_dismissals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE recurring_dismissals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY recurring_dismissals_select ON recurring_dismissals FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access()
                     WHERE level IN ('owner', 'full', 'view_only'))
);
--> statement-breakpoint
CREATE POLICY recurring_dismissals_write ON recurring_dismissals FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level IN ('owner', 'full')))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level IN ('owner', 'full')));
--> statement-breakpoint
CREATE TRIGGER recurring_dismissals_mark_write AFTER INSERT OR UPDATE OR DELETE ON recurring_dismissals
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
