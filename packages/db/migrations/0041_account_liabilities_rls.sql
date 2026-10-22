-- account_liabilities (#86): a card's or loan's APR, payments, and statement. Visible at owner and
-- full access only: view_only and balance_only members see the account and its balance, but not
-- these details (or that there are any). Written by owners, or by the worker in system context
-- (where fiscus_account_access() says owner).
ALTER TABLE account_liabilities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE account_liabilities FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY account_liabilities_select ON account_liabilities FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level IN ('owner', 'full'))
);
--> statement-breakpoint
CREATE POLICY account_liabilities_insert ON account_liabilities FOR INSERT WITH CHECK (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
);
--> statement-breakpoint
CREATE POLICY account_liabilities_update ON account_liabilities FOR UPDATE
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner'))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner'));
--> statement-breakpoint
CREATE POLICY account_liabilities_delete ON account_liabilities FOR DELETE USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
);
--> statement-breakpoint
CREATE TRIGGER account_liabilities_mark_write AFTER INSERT OR UPDATE OR DELETE ON account_liabilities
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
