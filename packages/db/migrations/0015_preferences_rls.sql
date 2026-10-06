-- A member's preferences are theirs alone: not even household owners or system jobs read them.
ALTER TABLE member_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE member_preferences FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY member_preferences_own ON member_preferences FOR ALL
  USING (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND member_id = fiscus_member()
  )
  WITH CHECK (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND member_id = fiscus_member()
  );
--> statement-breakpoint
CREATE TRIGGER member_preferences_mark_write AFTER INSERT OR UPDATE OR DELETE ON member_preferences
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
