-- settlements (#112): seen only by the two people it's between (and the worker), and recorded or
-- removed only by one of them, who recorded it as themselves.
ALTER TABLE settlements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE settlements FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY settlements_select ON settlements FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND (fiscus_is_system() OR fiscus_member() IN (from_member_id, to_member_id))
);
--> statement-breakpoint
CREATE POLICY settlements_insert ON settlements FOR INSERT WITH CHECK (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND created_by_member_id = fiscus_member()
  AND fiscus_member() IN (from_member_id, to_member_id)
);
--> statement-breakpoint
CREATE POLICY settlements_delete ON settlements FOR DELETE USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND fiscus_member() IN (from_member_id, to_member_id)
);
--> statement-breakpoint
CREATE TRIGGER settlements_mark_write AFTER INSERT OR UPDATE OR DELETE ON settlements
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
