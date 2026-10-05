-- Account visibility in the database (docs/design/accounts-and-visibility.md §3, ADR 0006 §4).
--
-- fiscus_account_access() answers "which accounts can the context member see, and at what level?"
-- from the source rows on every statement, so there is no derived state to drift. It is owned by
-- the read-only fiscus_definer role: a bug in it can't change data. Policies call it in an
-- uncorrelated subquery, which Postgres evaluates once per statement.
GRANT SELECT ON accounts, account_owners TO fiscus_definer;
--> statement-breakpoint
CREATE FUNCTION fiscus_account_access()
  RETURNS TABLE (account_id uuid, level account_access_level)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT a.id,
      CASE
        WHEN current_setting('app.system', true) = 'on' THEN 'owner'
        WHEN o.member_id IS NOT NULL THEN 'owner'
        WHEN a.visibility = 'full' THEN 'full'
        WHEN a.visibility = 'view_only' THEN 'view_only'
        ELSE 'balance_only'
      END::account_access_level
    FROM accounts a
    LEFT JOIN account_owners o ON o.account_id = a.id AND o.member_id = fiscus_member()
    WHERE a.household_id = fiscus_household()
      AND fiscus_context_valid()
      AND (
        current_setting('app.system', true) = 'on'
        OR o.member_id IS NOT NULL
        OR a.visibility <> 'private'
      )
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_account_access() OWNER TO fiscus_definer;
--> statement-breakpoint

-- May the context member change this account's owners? Owners may; so may anyone adding the first
-- owners of an account created in this transaction (the commit-time check below guarantees
-- every committed account has an owner, so "no owners" only happens mid-creation).
CREATE FUNCTION fiscus_can_manage_owners(p_account uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT fiscus_context_valid() AND (
      current_setting('app.system', true) = 'on'
      OR EXISTS (SELECT 1 FROM account_owners o
                 WHERE o.account_id = p_account AND o.member_id = fiscus_member())
      OR NOT EXISTS (SELECT 1 FROM account_owners o WHERE o.account_id = p_account)
    )
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_can_manage_owners(uuid) OWNER TO fiscus_definer;
--> statement-breakpoint

-- accounts: visible per fiscus_account_access(); only owners change or delete them. Inserts are
-- checked by household only, because a new account has no owners until the next statement
-- (the app inserts without RETURNING).
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY accounts_select ON accounts FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND id IN (SELECT account_id FROM fiscus_account_access())
);
--> statement-breakpoint
CREATE POLICY accounts_insert ON accounts FOR INSERT
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint
CREATE POLICY accounts_update ON accounts FOR UPDATE
  USING (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
  )
  WITH CHECK (household_id = fiscus_household());
--> statement-breakpoint
CREATE POLICY accounts_delete ON accounts FOR DELETE USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
);
--> statement-breakpoint

-- account_owners: visible with the account (the "Alex's" / "Ours" label needs them); changed only
-- through fiscus_can_manage_owners().
ALTER TABLE account_owners ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE account_owners FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY account_owners_select ON account_owners FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access())
);
--> statement-breakpoint
CREATE POLICY account_owners_insert ON account_owners FOR INSERT WITH CHECK (
  household_id = fiscus_household() AND fiscus_can_manage_owners(account_id)
);
--> statement-breakpoint
CREATE POLICY account_owners_update ON account_owners FOR UPDATE
  USING (household_id = fiscus_household() AND fiscus_can_manage_owners(account_id))
  WITH CHECK (household_id = fiscus_household() AND fiscus_can_manage_owners(account_id));
--> statement-breakpoint
CREATE POLICY account_owners_delete ON account_owners FOR DELETE USING (
  household_id = fiscus_household() AND fiscus_can_manage_owners(account_id)
);
--> statement-breakpoint

-- balance_snapshots: visible at every level (balance_only exists for exactly this); owners write.
ALTER TABLE balance_snapshots ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE balance_snapshots FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY balance_snapshots_select ON balance_snapshots FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access())
);
--> statement-breakpoint
CREATE POLICY balance_snapshots_insert ON balance_snapshots FOR INSERT WITH CHECK (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
);
--> statement-breakpoint
CREATE POLICY balance_snapshots_update ON balance_snapshots FOR UPDATE
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner'))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner'));
--> statement-breakpoint
CREATE POLICY balance_snapshots_delete ON balance_snapshots FOR DELETE USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
);
--> statement-breakpoint

-- audit_events: an event about an account is visible only to members who can see that account,
-- so the activity feed and audit log never reveal a hidden account (design §6). Chain
-- verification runs in system context, which sees everything.
DROP POLICY audit_events_select ON audit_events;
--> statement-breakpoint
CREATE POLICY audit_events_select ON audit_events FOR SELECT USING (
  household_id IS NULL OR (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND (account_id IS NULL OR account_id IN (SELECT account_id FROM fiscus_account_access()))
  )
);
--> statement-breakpoint

-- Ownership invariants, checked at commit so an owner set can be replaced in several statements:
-- every account has at least one owner, and shares sum to exactly 10 000 (ADR 0006 §2).
CREATE FUNCTION fiscus_check_account_owners() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_account uuid;
  v_owners int;
  v_total bigint;
BEGIN
  IF TG_TABLE_NAME = 'accounts' THEN
    v_account := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_account := OLD.account_id;
  ELSE
    v_account := NEW.account_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = v_account) THEN
    RETURN NULL; -- the account itself was deleted
  END IF;
  SELECT count(*), coalesce(sum(share_bps), 0) INTO v_owners, v_total
    FROM account_owners WHERE account_id = v_account;
  IF v_owners = 0 THEN
    RAISE EXCEPTION 'account % has no owners', v_account
      USING ERRCODE = 'check_violation', CONSTRAINT = 'account_owners_required';
  END IF;
  IF v_total <> 10000 THEN
    RAISE EXCEPTION 'account % owner shares sum to %, not 10000', v_account, v_total
      USING ERRCODE = 'check_violation', CONSTRAINT = 'account_owners_total';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_check_account_owners() OWNER TO fiscus_definer;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER accounts_owners_required AFTER INSERT ON accounts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fiscus_check_account_owners();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER account_owners_valid AFTER INSERT OR UPDATE OR DELETE ON account_owners
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fiscus_check_account_owners();
--> statement-breakpoint

-- Owners are active members who may own accounts: not viewers (EDGE-05), not departed.
CREATE FUNCTION fiscus_check_owner_member() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM household_members m
    WHERE m.id = NEW.member_id AND m.left_at IS NULL AND m.role IN ('owner', 'member')
  ) THEN
    RAISE EXCEPTION 'member % cannot own accounts', NEW.member_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'account_owners_member';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_check_owner_member() OWNER TO fiscus_definer;
--> statement-breakpoint
CREATE TRIGGER account_owners_member BEFORE INSERT OR UPDATE OF member_id ON account_owners
  FOR EACH ROW EXECUTE FUNCTION fiscus_check_owner_member();
--> statement-breakpoint

-- A member who owns accounts can't become a viewer (HH-06) or leave until those accounts have
-- other owners. The guided departure flow (#62) will hand them over first.
CREATE FUNCTION fiscus_check_member_owns_accounts() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF ((NEW.role = 'viewer' AND OLD.role <> 'viewer') OR (NEW.left_at IS NOT NULL AND OLD.left_at IS NULL))
     AND EXISTS (SELECT 1 FROM account_owners o WHERE o.member_id = NEW.id) THEN
    RAISE EXCEPTION 'member % owns accounts', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'household_members_owns_accounts';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_check_member_owns_accounts() OWNER TO fiscus_definer;
--> statement-breakpoint
CREATE TRIGGER household_members_owns_accounts BEFORE UPDATE OF role, left_at ON household_members
  FOR EACH ROW EXECUTE FUNCTION fiscus_check_member_owns_accounts();
--> statement-breakpoint

-- Every household write records activity (ADR 0013 §1).
CREATE TRIGGER accounts_mark_write AFTER INSERT OR UPDATE OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint
CREATE TRIGGER account_owners_mark_write AFTER INSERT OR UPDATE OR DELETE ON account_owners
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint
CREATE TRIGGER balance_snapshots_mark_write AFTER INSERT OR UPDATE OR DELETE ON balance_snapshots
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
