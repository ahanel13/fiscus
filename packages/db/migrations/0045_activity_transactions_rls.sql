-- Which transactions each activity entry touched (#46, permissions TXN-11). A link is visible to
-- whoever can see its transaction (the transactions policy, 0012): the entry itself is still
-- filtered by its own policy (0010), so a member never sees an event about an account hidden
-- from them through a transaction's history. A link can only name a transaction its writer can
-- see. Append-only for the app, like audit_events (0003).
ALTER TABLE activity_transactions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE activity_transactions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY activity_transactions_select ON activity_transactions FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND transaction_id IN (SELECT t.id FROM transactions t)
);
--> statement-breakpoint
CREATE POLICY activity_transactions_insert ON activity_transactions FOR INSERT WITH CHECK (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND transaction_id IN (SELECT t.id FROM transactions t)
);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON activity_transactions FROM fiscus_app;
--> statement-breakpoint
CREATE TRIGGER activity_transactions_mark_write AFTER INSERT ON activity_transactions
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
