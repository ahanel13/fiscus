-- settle_up_simplify_consents (#262, D31): everyone in the household sees who has agreed to
-- settle with the fewest transfers, so they can see who it's waiting for. Only you add or remove
-- your own agreement. Viewers can't agree: that's the api's to enforce, as for settle-ups.
ALTER TABLE settle_up_simplify_consents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE settle_up_simplify_consents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY settle_up_simplify_consents_select ON settle_up_simplify_consents FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
);
--> statement-breakpoint
CREATE POLICY settle_up_simplify_consents_insert ON settle_up_simplify_consents FOR INSERT
  WITH CHECK (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND member_id = fiscus_member()
  );
--> statement-breakpoint
CREATE POLICY settle_up_simplify_consents_delete ON settle_up_simplify_consents FOR DELETE USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND member_id = fiscus_member()
);
--> statement-breakpoint
CREATE TRIGGER settle_up_simplify_consents_mark_write AFTER INSERT OR UPDATE OR DELETE
  ON settle_up_simplify_consents FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
