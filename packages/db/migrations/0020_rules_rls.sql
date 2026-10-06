-- Rules are household-wide: every member reads them (RULE-01); the API limits writes to owners
-- and members (RULE-03), as for categories. What a rule may change is decided at run time from
-- its author's access (RULE-05), in the API.
ALTER TABLE rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE rules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY rules_household ON rules FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint
CREATE TRIGGER rules_mark_write AFTER INSERT OR UPDATE OR DELETE ON rules
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
