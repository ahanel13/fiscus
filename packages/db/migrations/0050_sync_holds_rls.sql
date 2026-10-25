-- sync_holds (#80): synced transactions waiting for a person to say whether they're one already in
-- the account. Only the account's owners see and decide them: deciding "different" adds the
-- transaction and rebuilds the account's computed balances, which only owners may do (TXN-09, as
-- for imports). The worker writes them in system context, where fiscus_account_access() says owner.
ALTER TABLE sync_holds ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sync_holds FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sync_holds_select ON sync_holds FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
);
--> statement-breakpoint
CREATE POLICY sync_holds_insert ON sync_holds FOR INSERT WITH CHECK (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
);
--> statement-breakpoint
CREATE POLICY sync_holds_update ON sync_holds FOR UPDATE
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner'))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner'));
--> statement-breakpoint
CREATE POLICY sync_holds_delete ON sync_holds FOR DELETE USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
);
--> statement-breakpoint
CREATE TRIGGER sync_holds_mark_write AFTER INSERT OR UPDATE OR DELETE ON sync_holds
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
