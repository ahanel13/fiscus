-- split_policies (#109): the household's, read by everyone in it. Who may change them (owners and
-- members, not viewers) is the api's to enforce, as for categories; every change is in the
-- household's activity.
ALTER TABLE split_policies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE split_policies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY split_policies_household ON split_policies FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint
CREATE TRIGGER split_policies_mark_write AFTER INSERT OR UPDATE OR DELETE ON split_policies
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
