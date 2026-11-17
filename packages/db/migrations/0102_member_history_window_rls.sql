-- The member history window (#256, ADR 0012 §Joining): a member who joins later sees the
-- household's shared records from their history_from date on. It covers the records that belong
-- to the household rather than to an account: the household budget's months, the household goals'
-- claim history, and the activity feed. Accounts aren't windowed: sharing an account shares its
-- whole history (#291), and so do the transactions, balances and events on it, and anything
-- attributed to you. Settle-ups are seen only by the two people they're between (0061).
--
-- Existing members keep null (all of it), so nothing they could see goes. Owners can widen a
-- member's window, never narrow it.

-- Set on joining: the join date, in the household's time zone. The household's first member has
-- no one's history before them, so theirs stays null.
CREATE FUNCTION fiscus_set_history_from() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NEW.history_from IS NULL AND EXISTS (
    SELECT 1 FROM household_members m WHERE m.household_id = NEW.household_id
  ) THEN
    NEW.history_from := (NEW.joined_at AT TIME ZONE
      (SELECT h.timezone FROM households h WHERE h.id = NEW.household_id))::date;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_set_history_from() OWNER TO fiscus_definer;
--> statement-breakpoint
CREATE TRIGGER household_members_history_from BEFORE INSERT ON household_members
  FOR EACH ROW EXECUTE FUNCTION fiscus_set_history_from();
--> statement-breakpoint

-- Widened only (earlier, or null for all of it), and only by one of the household's owners.
-- Outside any household context (the schema owner, a restore) only the first rule applies.
CREATE FUNCTION fiscus_check_history_from() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NEW.history_from IS NOT DISTINCT FROM OLD.history_from THEN
    RETURN NEW;
  END IF;
  IF OLD.history_from IS NULL OR NEW.history_from > OLD.history_from THEN
    RAISE EXCEPTION 'A member''s history window can only be widened'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'household_members_history_widen_only';
  END IF;
  IF fiscus_household() IS NOT NULL
     AND current_setting('app.system', true) IS DISTINCT FROM 'on'
     AND NOT EXISTS (
       SELECT 1 FROM household_members m
       WHERE m.id = fiscus_member() AND m.household_id = NEW.household_id
         AND m.user_id = fiscus_user() AND m.role = 'owner' AND m.left_at IS NULL
     ) THEN
    RAISE EXCEPTION 'Only an owner can widen a member''s history window'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'household_members_history_owner';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_check_history_from() OWNER TO fiscus_definer;
--> statement-breakpoint
CREATE TRIGGER household_members_check_history_from BEFORE UPDATE OF history_from
  ON household_members FOR EACH ROW EXECUTE FUNCTION fiscus_check_history_from();
--> statement-breakpoint

-- The caller's window: the first day of household-shared records they see, and the moment it
-- starts in the household's time zone. Null for all of it, and in system context (the worker's
-- jobs filter what they surface for their recipient, who runs in their own context).
CREATE FUNCTION fiscus_history_from() RETURNS date
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT m.history_from FROM household_members m
    WHERE m.id = fiscus_member() AND m.household_id = fiscus_household()
      AND current_setting('app.system', true) IS DISTINCT FROM 'on'
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_history_from() OWNER TO fiscus_definer;
--> statement-breakpoint
CREATE FUNCTION fiscus_history_start() RETURNS timestamptz
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT fiscus_history_from()::timestamp AT TIME ZONE h.timezone
    FROM households h WHERE h.id = fiscus_household()
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_history_start() OWNER TO fiscus_definer;
--> statement-breakpoint

GRANT SELECT ON budgets, budget_amounts TO fiscus_definer;
--> statement-breakpoint

-- The first month of a budget the caller sees: their window's month for the household's budget;
-- null (all of it) for their own budget, or with no window.
CREATE FUNCTION fiscus_budget_window(p_budget uuid) RETURNS date
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT date_trunc('month', fiscus_history_from())::date
    FROM budgets b WHERE b.id = p_budget AND b.member_id IS NULL
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_budget_window(uuid) OWNER TO fiscus_definer;
--> statement-breakpoint

-- A month's amounts carry forward until a later month sets them (amountsFor), so the window's
-- first month runs on the last amounts set on or before it: those stay visible, earlier ones go.
CREATE FUNCTION fiscus_budget_amounts_from(p_budget uuid) RETURNS date
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT coalesce(
      (SELECT max(a.month) FROM budget_amounts a WHERE a.budget_id = p_budget AND a.month <= w.m),
      w.m)
    FROM (SELECT fiscus_budget_window(p_budget) AS m) w
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_budget_amounts_from(uuid) OWNER TO fiscus_definer;
--> statement-breakpoint

-- The household budget's amounts and moved money, from the window on. Written only inside it.
CREATE POLICY budget_amounts_history ON budget_amounts AS RESTRICTIVE FOR ALL
  USING (month >= coalesce(fiscus_budget_amounts_from(budget_id), '-infinity'::date))
  WITH CHECK (month >= coalesce(fiscus_budget_window(budget_id), '-infinity'::date));
--> statement-breakpoint
CREATE POLICY budget_moves_history ON budget_moves AS RESTRICTIVE FOR ALL
  USING (month >= coalesce(fiscus_budget_window(budget_id), '-infinity'::date))
  WITH CHECK (month >= coalesce(fiscus_budget_window(budget_id), '-infinity'::date));
--> statement-breakpoint

-- Goals' claim history (G17), from the window on, plus what you did yourself.
CREATE POLICY goal_claim_events_history ON goal_claim_events AS RESTRICTIVE FOR SELECT
  USING (at >= coalesce((SELECT fiscus_history_start()), '-infinity'::timestamptz)
    OR member_id = fiscus_member());
--> statement-breakpoint

-- The activity feed and audit log: household events from the window on. Events about an account
-- follow the account (0010) whatever their date, and you always see what you did and what was
-- done to your own membership.
CREATE POLICY audit_events_history ON audit_events AS RESTRICTIVE FOR SELECT
  USING (
    household_id IS NULL
    OR account_id IS NOT NULL
    OR occurred_at >= coalesce((SELECT fiscus_history_start()), '-infinity'::timestamptz)
    OR actor_member_id = fiscus_member()
    OR (target_type = 'household_member' AND target_id = fiscus_member()::text)
  );
