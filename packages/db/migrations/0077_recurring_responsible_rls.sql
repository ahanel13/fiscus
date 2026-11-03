-- Who looks after a bill (#121; bills walkthrough D13). Whoever it is must see the series' account:
-- own it, or be in the household while the account is shared in full or view-only. Checked here,
-- whoever sets it (the api, a hand-over, a departure), so a private card's bills never go to
-- someone who can't see the card.
GRANT SELECT ON recurring_series TO fiscus_definer;
--> statement-breakpoint
CREATE FUNCTION fiscus_check_series_responsible() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NEW.responsible_member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM household_members m
    JOIN accounts a ON a.id = NEW.account_id AND a.household_id = m.household_id
    WHERE m.id = NEW.responsible_member_id AND m.household_id = NEW.household_id
      AND m.left_at IS NULL
      AND (a.visibility IN ('full', 'view_only')
           OR EXISTS (SELECT 1 FROM account_owners o
                      WHERE o.account_id = a.id AND o.member_id = m.id))
  ) THEN
    RAISE EXCEPTION 'member % cannot see the account of series %', NEW.responsible_member_id, NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'recurring_series_responsible';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_check_series_responsible() OWNER TO fiscus_definer;
--> statement-breakpoint
CREATE TRIGGER recurring_series_responsible BEFORE INSERT OR UPDATE OF responsible_member_id, account_id
  ON recurring_series
  FOR EACH ROW EXECUTE FUNCTION fiscus_check_series_responsible();
--> statement-breakpoint

-- Handing a bill to someone else (REC-04): anyone who sees the series can, view-only access
-- included, though only owner and full access change the rest of it (0068). This changes who
-- looks after it and nothing else. Returns false when the context member can't see the series.
GRANT SELECT, UPDATE (responsible_member_id, version, updated_at) ON recurring_series
  TO fiscus_steward;
--> statement-breakpoint
GRANT SELECT ON account_owners TO fiscus_steward;
--> statement-breakpoint
CREATE FUNCTION fiscus_hand_over_series(p_series uuid, p_member uuid) RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  WITH changed AS (
    UPDATE recurring_series s
    SET responsible_member_id = p_member, version = s.version + 1, updated_at = now()
    WHERE s.id = p_series AND s.household_id = fiscus_household() AND fiscus_context_valid()
      AND s.account_id IN (SELECT account_id FROM fiscus_account_access()
                           WHERE level IN ('owner', 'full', 'view_only'))
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM changed)
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_hand_over_series(uuid, uuid) OWNER TO fiscus_steward;
--> statement-breakpoint

-- When someone leaves the household, or is removed (D13): their bills pass to the account's other
-- owner (the largest share, then whoever joined first), else to the household's first owner who
-- can see the account. Nobody left who can see it: null, and the api works it out when read.
-- Whoever removes them may not see those series, as with their rules (0039).
CREATE FUNCTION fiscus_pass_member_series() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  UPDATE recurring_series s
  SET responsible_member_id = coalesce(
        (SELECT o.member_id FROM account_owners o
         JOIN household_members m ON m.id = o.member_id AND m.left_at IS NULL
         WHERE o.account_id = s.account_id AND o.member_id <> NEW.id
         ORDER BY o.share_bps DESC, m.joined_at, m.id LIMIT 1),
        (SELECT m.id FROM household_members m
         JOIN accounts a ON a.id = s.account_id
         WHERE m.household_id = NEW.household_id AND m.role = 'owner' AND m.left_at IS NULL
           AND m.id <> NEW.id AND a.visibility IN ('full', 'view_only')
         ORDER BY m.joined_at, m.id LIMIT 1)),
      version = s.version + 1,
      updated_at = now()
  WHERE s.household_id = NEW.household_id AND s.responsible_member_id = NEW.id;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_pass_member_series() OWNER TO fiscus_steward;
--> statement-breakpoint
CREATE TRIGGER household_members_pass_series AFTER UPDATE OF left_at ON household_members
  FOR EACH ROW WHEN (OLD.left_at IS NULL AND NEW.left_at IS NOT NULL)
  EXECUTE FUNCTION fiscus_pass_member_series();
--> statement-breakpoint

-- Series made before this release: the account's only owner, else whoever made it, if they're
-- still here (D13). The rest stay null and are worked out when read.
UPDATE recurring_series s
SET responsible_member_id = coalesce(
  (SELECT min(o.member_id::text)::uuid FROM account_owners o
   JOIN household_members m ON m.id = o.member_id AND m.left_at IS NULL
   WHERE o.account_id = s.account_id
   HAVING count(*) = 1),
  (SELECT m.id FROM household_members m
   WHERE m.id = s.created_by_member_id AND m.left_at IS NULL
     AND (EXISTS (SELECT 1 FROM accounts a WHERE a.id = s.account_id
                  AND a.visibility IN ('full', 'view_only'))
          OR EXISTS (SELECT 1 FROM account_owners o
                     WHERE o.account_id = s.account_id AND o.member_id = m.id))))
WHERE s.responsible_member_id IS NULL AND s.kind <> 'income';
