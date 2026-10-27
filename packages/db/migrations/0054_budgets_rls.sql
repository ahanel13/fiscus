-- Budgets (#98). The household's budget (member_id null) is everyone's; a member's own is theirs
-- alone, and no one else sees it or that it exists (budgeting walkthrough D3). The tables under a
-- budget follow it: a row is visible exactly when its budget is. Who may change the household's
-- budget (owners and members, not viewers) is the api's to enforce, as for rules.
ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE budgets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY budgets_household ON budgets FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint
CREATE POLICY budgets_member ON budgets AS RESTRICTIVE FOR ALL
  USING (member_id IS NULL OR member_id = fiscus_member() OR (SELECT fiscus_is_system()))
  WITH CHECK (member_id IS NULL OR member_id = fiscus_member() OR (SELECT fiscus_is_system()));
--> statement-breakpoint
CREATE TRIGGER budgets_mark_write AFTER INSERT OR UPDATE OR DELETE ON budgets
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint

ALTER TABLE budget_strategies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE budget_strategies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY budget_strategies_household ON budget_strategies FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint
CREATE POLICY budget_strategies_budget ON budget_strategies AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM budgets b WHERE b.id = budget_id))
  WITH CHECK (EXISTS (SELECT 1 FROM budgets b WHERE b.id = budget_id));
--> statement-breakpoint
CREATE TRIGGER budget_strategies_mark_write AFTER INSERT OR UPDATE OR DELETE ON budget_strategies
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint

ALTER TABLE budget_amounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE budget_amounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY budget_amounts_household ON budget_amounts FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint
CREATE POLICY budget_amounts_budget ON budget_amounts AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM budgets b WHERE b.id = budget_id))
  WITH CHECK (EXISTS (SELECT 1 FROM budgets b WHERE b.id = budget_id));
--> statement-breakpoint
CREATE TRIGGER budget_amounts_mark_write AFTER INSERT OR UPDATE OR DELETE ON budget_amounts
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint

ALTER TABLE budget_categories ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE budget_categories FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY budget_categories_household ON budget_categories FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint
CREATE POLICY budget_categories_budget ON budget_categories AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM budgets b WHERE b.id = budget_id))
  WITH CHECK (EXISTS (SELECT 1 FROM budgets b WHERE b.id = budget_id));
--> statement-breakpoint
CREATE TRIGGER budget_categories_mark_write AFTER INSERT OR UPDATE OR DELETE ON budget_categories
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint

-- A member's own budget goes when they leave or are removed, as their rules do (RULE-07).
-- Members leave by left_at, so the foreign key's cascade never fires for them, and whoever removes
-- them can't see their budget. The tables under it go by their foreign keys' cascade. Moving out
-- with their history (ADR 0012, #253) copies it to their new household before they leave.
GRANT SELECT, DELETE ON budgets TO fiscus_steward;
--> statement-breakpoint
CREATE FUNCTION fiscus_delete_member_budget() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  DELETE FROM budgets WHERE household_id = NEW.household_id AND member_id = NEW.id;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_delete_member_budget() OWNER TO fiscus_steward;
--> statement-breakpoint
CREATE TRIGGER household_members_delete_budget AFTER UPDATE OF left_at ON household_members
  FOR EACH ROW WHEN (OLD.left_at IS NULL AND NEW.left_at IS NOT NULL)
  EXECUTE FUNCTION fiscus_delete_member_budget();
