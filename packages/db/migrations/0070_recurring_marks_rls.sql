-- What someone said about a date a recurring series was due (#120). A mark goes with its series:
-- visible when the series is, and made or removed by those who can change the series (owner or
-- full access to its account), as 0068 has it.
ALTER TABLE recurring_marks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE recurring_marks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY recurring_marks_select ON recurring_marks FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND EXISTS (SELECT 1 FROM recurring_series s WHERE s.id = series_id)
);
--> statement-breakpoint
CREATE POLICY recurring_marks_write ON recurring_marks FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND EXISTS (SELECT 1 FROM recurring_series s WHERE s.id = series_id AND s.account_id IN
    (SELECT account_id FROM fiscus_account_access() WHERE level IN ('owner', 'full'))))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND EXISTS (SELECT 1 FROM recurring_series s WHERE s.id = series_id AND s.account_id IN
    (SELECT account_id FROM fiscus_account_access() WHERE level IN ('owner', 'full'))));
--> statement-breakpoint
CREATE TRIGGER recurring_marks_mark_write AFTER INSERT OR UPDATE OR DELETE ON recurring_marks
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
