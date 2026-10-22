-- Rules of your own (#58, permissions RULE-02/04/07). Added to 0020's policy, not replacing it: a
-- restrictive policy narrows what the permissive one allows, so household rules (member_id null,
-- every row before this release) read and write exactly as before, and only their member, or the
-- worker, sees or changes a member's rules.
CREATE POLICY rules_member ON rules AS RESTRICTIVE FOR ALL
  USING (member_id IS NULL OR member_id = fiscus_member() OR (SELECT fiscus_is_system()))
  WITH CHECK (member_id IS NULL OR member_id = fiscus_member() OR (SELECT fiscus_is_system()));
--> statement-breakpoint

-- The rules engine runs every owner's rules on a joint account (imports.md §3). Importing into one
-- needs the other owners' rules, which the importer can't read: this returns them, enabled ones
-- only, and only for accounts the context member owns too. The api runs them and never returns
-- them, so another member's rules are seen only by what they do on an account you share.
GRANT SELECT ON rules TO fiscus_definer;
--> statement-breakpoint
CREATE FUNCTION fiscus_owner_rules(p_accounts uuid[]) RETURNS SETOF rules
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT r.* FROM rules r
    WHERE r.household_id = fiscus_household()
      AND fiscus_context_valid()
      AND r.enabled
      AND r.member_id IN (
        SELECT o.member_id FROM account_owners o
        WHERE o.account_id = ANY(p_accounts)
          AND EXISTS (SELECT 1 FROM account_owners me
                      WHERE me.account_id = o.account_id AND me.member_id = fiscus_member())
      )
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_owner_rules(uuid[]) OWNER TO fiscus_definer;
--> statement-breakpoint

-- RULE-07: a member's rules go when they leave or are removed. Members leave by left_at, so the
-- foreign key's cascade never fires for them; whoever removes them can't see their rules either.
GRANT SELECT, DELETE ON rules TO fiscus_steward;
--> statement-breakpoint
CREATE FUNCTION fiscus_delete_member_rules() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  DELETE FROM rules WHERE household_id = NEW.household_id AND member_id = NEW.id;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_delete_member_rules() OWNER TO fiscus_steward;
--> statement-breakpoint
CREATE TRIGGER household_members_delete_rules AFTER UPDATE OF left_at ON household_members
  FOR EACH ROW WHEN (OLD.left_at IS NULL AND NEW.left_at IS NOT NULL)
  EXECUTE FUNCTION fiscus_delete_member_rules();
