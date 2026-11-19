-- funding_targets (#113): an agreement between a joint account's owners. Seen by whoever sees the
-- account's transactions, as the money it tracks is (and by the worker); set, changed and removed
-- only by the account's owners. Who a target may name (an owner of the account) is the api's to
-- check.
ALTER TABLE funding_targets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE funding_targets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY funding_targets_select ON funding_targets FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND ((SELECT fiscus_is_system())
    OR account_id IN (SELECT account_id FROM fiscus_account_access()
                      WHERE level IN ('owner', 'full', 'view_only')))
);
--> statement-breakpoint
CREATE POLICY funding_targets_insert ON funding_targets FOR INSERT WITH CHECK (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND created_by_member_id = fiscus_member()
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
);
--> statement-breakpoint
CREATE POLICY funding_targets_update ON funding_targets FOR UPDATE USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
) WITH CHECK (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND created_by_member_id = fiscus_member()
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
);
--> statement-breakpoint
CREATE POLICY funding_targets_delete ON funding_targets FOR DELETE USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
);
--> statement-breakpoint
CREATE TRIGGER funding_targets_mark_write AFTER INSERT OR UPDATE OR DELETE ON funding_targets
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
