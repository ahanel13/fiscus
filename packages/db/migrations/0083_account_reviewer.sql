ALTER TABLE "accounts" ADD COLUMN "reviewer_member_id" uuid;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_household_id_reviewer_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","reviewer_member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Who reviews an account's transactions (#45). Whoever it is must be able to categorize them: not a
-- viewer, and own the account or be in the household while it's shared in full. Setting someone else is refused;
-- when a change of visibility or owners takes that away, the account goes back to no reviewer
-- (everyone who can review it), as it does when the reviewer leaves.
CREATE FUNCTION fiscus_check_account_reviewer() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NEW.reviewer_member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM household_members m
    WHERE m.id = NEW.reviewer_member_id AND m.household_id = NEW.household_id
      AND m.left_at IS NULL AND m.role <> 'viewer'
      AND (NEW.visibility = 'full'
           OR EXISTS (SELECT 1 FROM account_owners o
                      WHERE o.account_id = NEW.id AND o.member_id = m.id))
  ) THEN
    IF TG_OP = 'UPDATE' AND NEW.reviewer_member_id IS NOT DISTINCT FROM OLD.reviewer_member_id THEN
      NEW.reviewer_member_id := NULL;
    ELSE
      RAISE EXCEPTION 'member % cannot review account %', NEW.reviewer_member_id, NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'accounts_reviewer';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_check_account_reviewer() OWNER TO fiscus_definer;
--> statement-breakpoint
CREATE TRIGGER accounts_reviewer BEFORE INSERT OR UPDATE OF reviewer_member_id, visibility
  ON accounts
  FOR EACH ROW EXECUTE FUNCTION fiscus_check_account_reviewer();
--> statement-breakpoint

-- An owner taken off a private account stops reviewing it. Whoever changes the owners may not be
-- able to change the reviewer, so this runs as the steward.
GRANT SELECT, UPDATE (reviewer_member_id) ON accounts TO fiscus_steward;
--> statement-breakpoint
CREATE FUNCTION fiscus_clear_owner_reviewer() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  UPDATE accounts a SET reviewer_member_id = NULL
  WHERE a.id = OLD.account_id AND a.reviewer_member_id = OLD.member_id AND a.visibility <> 'full';
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_clear_owner_reviewer() OWNER TO fiscus_steward;
--> statement-breakpoint
CREATE TRIGGER account_owners_clear_reviewer AFTER DELETE ON account_owners
  FOR EACH ROW EXECUTE FUNCTION fiscus_clear_owner_reviewer();
--> statement-breakpoint

-- Someone who leaves the household, or is removed, stops reviewing.
CREATE FUNCTION fiscus_clear_member_reviewer() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  UPDATE accounts a SET reviewer_member_id = NULL
  WHERE a.household_id = NEW.household_id AND a.reviewer_member_id = NEW.id;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_clear_member_reviewer() OWNER TO fiscus_steward;
--> statement-breakpoint
CREATE TRIGGER household_members_clear_reviewer AFTER UPDATE OF left_at ON household_members
  FOR EACH ROW WHEN (OLD.left_at IS NULL AND NEW.left_at IS NOT NULL)
  EXECUTE FUNCTION fiscus_clear_member_reviewer();
