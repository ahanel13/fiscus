-- Recurring series (#118). A series is visible to whoever sees its account's transactions (bills
-- walkthrough D10): owner, full and view_only access. Those who can change the account's
-- transactions (owner and full) can make and change its series. Who may (owners and members, not
-- viewers) is the api's to enforce, as for rules.
ALTER TABLE recurring_series ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE recurring_series FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY recurring_series_select ON recurring_series FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access()
                     WHERE level IN ('owner', 'full', 'view_only'))
);
--> statement-breakpoint
CREATE POLICY recurring_series_insert ON recurring_series FOR INSERT WITH CHECK (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level IN ('owner', 'full'))
);
--> statement-breakpoint
CREATE POLICY recurring_series_update ON recurring_series FOR UPDATE
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level IN ('owner', 'full')))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level IN ('owner', 'full')));
--> statement-breakpoint
CREATE POLICY recurring_series_delete ON recurring_series FOR DELETE USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level IN ('owner', 'full'))
);
--> statement-breakpoint
CREATE TRIGGER recurring_series_mark_write AFTER INSERT OR UPDATE OR DELETE ON recurring_series
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
