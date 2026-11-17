-- Budget templates (#105). Under a budget, so they're seen exactly as it is (0054): the
-- household's budget's by everyone in it, a member's own budget's by them alone. Who may change
-- the household's (owners and members, not viewers) is the api's to enforce, as for the budget.
ALTER TABLE budget_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE budget_templates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY budget_templates_household ON budget_templates FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint
CREATE POLICY budget_templates_budget ON budget_templates AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM budgets b WHERE b.id = budget_id))
  WITH CHECK (EXISTS (SELECT 1 FROM budgets b WHERE b.id = budget_id));
--> statement-breakpoint
CREATE TRIGGER budget_templates_mark_write AFTER INSERT OR UPDATE OR DELETE ON budget_templates
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
