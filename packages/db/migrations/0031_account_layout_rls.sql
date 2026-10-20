-- A member's arrangement of their accounts list is theirs alone (#48), like their preferences
-- (0015): not even household owners or system jobs read it.
ALTER TABLE account_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE account_groups FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY account_groups_own ON account_groups FOR ALL
  USING (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND member_id = fiscus_member()
  )
  WITH CHECK (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND member_id = fiscus_member()
  );
--> statement-breakpoint
CREATE TRIGGER account_groups_mark_write AFTER INSERT OR UPDATE OR DELETE ON account_groups
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint
ALTER TABLE account_placements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE account_placements FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY account_placements_own ON account_placements FOR ALL
  USING (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND member_id = fiscus_member()
  )
  WITH CHECK (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND member_id = fiscus_member()
  );
--> statement-breakpoint
CREATE TRIGGER account_placements_mark_write AFTER INSERT OR UPDATE OR DELETE ON account_placements
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint
-- A placement's group is one of the same member's. Deleting the group sends its accounts back to
-- their type's section: only group_id is cleared (Postgres 15+), keeping the placement's order.
-- Not in the Drizzle schema, which can't express the column list.
ALTER TABLE account_placements ADD CONSTRAINT account_placements_group_fk
  FOREIGN KEY (member_id, group_id) REFERENCES account_groups (member_id, id)
  ON DELETE SET NULL (group_id);
