-- System context belongs to the worker (#271). `app.system = on` is honored for any connection as
-- fiscus_app, so SQL injected into the api could claim to be a worker job and read any household:
-- row-level security guards against logic bugs, not against arbitrary SQL. The fix, in two steps
-- (expand, then contract: docs/design/upgrades.md §1.3, the previous release must still work):
-- 1. This migration: fiscus_worker, a login role of its own; and narrow SECURITY DEFINER
--    functions, each checking the context it's called in, for what the api used system context
--    for. The api moves onto them and stops setting app.system.
-- 2. In the next release: fiscus_is_system() also requires session_user = 'fiscus_worker' (#376),
--    once no supported api relies on system context.
-- Parameterized queries (Drizzle) remain the defense against SQL injection; this limits what one
-- could do if it got through.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fiscus_worker') THEN
    CREATE ROLE fiscus_worker NOLOGIN;
  END IF;
  -- Owner of the definer functions that write. Like fiscus_definer it bypasses RLS, but it holds
  -- only the column privileges those functions need.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fiscus_steward') THEN
    CREATE ROLE fiscus_steward NOLOGIN BYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
-- The worker gets exactly the app's privileges, including later grants and revokes; only who it
-- is differs. fiscus_app isn't a member of fiscus_worker, so it can't SET ROLE to it.
GRANT fiscus_app TO fiscus_worker;
--> statement-breakpoint

-- A worker job acting for the whole household. Unchanged for now, since the previous release's api
-- still uses it; step 2 adds `session_user = 'fiscus_worker'` (the login role, which neither SET
-- ROLE nor SECURITY DEFINER changes).
CREATE FUNCTION fiscus_is_system() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT current_setting('app.system', true) = 'on' $$;
--> statement-breakpoint

-- The three functions that honored app.system (0005, 0010), now through fiscus_is_system().
CREATE OR REPLACE FUNCTION fiscus_context_valid() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT fiscus_household() IS NOT NULL AND (
      fiscus_is_system()
      OR EXISTS (
        SELECT 1 FROM household_members m
        WHERE m.id = fiscus_member()
          AND m.household_id = fiscus_household()
          AND m.user_id = fiscus_user()
          AND m.left_at IS NULL
      )
    )
  $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fiscus_account_access()
  RETURNS TABLE (account_id uuid, level account_access_level)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT a.id,
      CASE
        WHEN fiscus_is_system() THEN 'owner'
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
        fiscus_is_system()
        OR o.member_id IS NOT NULL
        OR a.visibility <> 'private'
      )
  $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fiscus_can_manage_owners(p_account uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT fiscus_context_valid() AND (
      fiscus_is_system()
      OR EXISTS (SELECT 1 FROM account_owners o
                 WHERE o.account_id = p_account AND o.member_id = fiscus_member())
      OR NOT EXISTS (SELECT 1 FROM account_owners o WHERE o.account_id = p_account)
    )
  $$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO fiscus_steward;
--> statement-breakpoint
GRANT SELECT ON households, household_members, invites, categories, transactions TO fiscus_steward;
--> statement-breakpoint
GRANT SELECT (id, email, display_name) ON users TO fiscus_steward;
--> statement-breakpoint
GRANT INSERT ON households, household_members TO fiscus_steward;
--> statement-breakpoint
GRANT UPDATE (accepted_at, accepted_by_user_id) ON invites TO fiscus_steward;
--> statement-breakpoint
GRANT UPDATE (category_id, version, updated_at) ON transactions TO fiscus_steward;
--> statement-breakpoint
GRANT SELECT ON household_keys, audit_events TO fiscus_definer;
--> statement-breakpoint

-- Creating a household: the household and its owner, the context's user, before any membership
-- exists. The caller then sets app.member_id to the returned member and does everything else
-- (settings, data key, categories, activity) as that owner, under the usual policies.
CREATE FUNCTION fiscus_create_household(
  p_name text,
  p_base_currency text,
  p_timezone text,
  p_display_name text,
  p_color text
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_member uuid;
BEGIN
  IF fiscus_household() IS NULL OR fiscus_user() IS NULL OR fiscus_member() IS NOT NULL THEN
    RAISE EXCEPTION 'fiscus_create_household needs a new household id and a user in context';
  END IF;
  -- An existing id fails on the primary key: this never adds an owner to a household.
  INSERT INTO households (id, name, base_currency, timezone)
    VALUES (fiscus_household(), p_name, p_base_currency, p_timezone);
  INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
    SELECT uuidv7(), fiscus_household(), u.id, 'owner', coalesce(p_display_name, u.display_name),
           p_color
    FROM users u WHERE u.id = fiscus_user()
    RETURNING id INTO v_member;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'fiscus_create_household: the context user does not exist';
  END IF;
  RETURN v_member;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_create_household(text, text, text, text, text) OWNER TO fiscus_steward;
--> statement-breakpoint

-- Accepting an invite: the context's user joins the context's household, only with the invite's
-- token, only if it's still live, and only if their email is the one invited. Returns no row for
-- an invite that isn't (any more) valid. The color is the first of p_colors no active member has.
CREATE FUNCTION fiscus_join_household(p_token_hash bytea, p_colors text[])
  RETURNS TABLE (member_id uuid, invite_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_invite record;
  v_user record;
  v_taken text[];
  v_active integer;
  v_color text;
  v_member uuid;
BEGIN
  IF fiscus_household() IS NULL OR fiscus_user() IS NULL OR fiscus_member() IS NOT NULL THEN
    RAISE EXCEPTION 'fiscus_join_household needs the invite''s household and a user in context';
  END IF;
  SELECT i.id, i.email, i.role INTO v_invite
    FROM invites i JOIN households h ON h.id = i.household_id
    WHERE i.token_hash = p_token_hash AND i.household_id = fiscus_household()
      AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
      AND h.status = 'active'
    FOR UPDATE OF i;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT u.id, u.email, u.display_name INTO v_user FROM users u WHERE u.id = fiscus_user();
  IF NOT FOUND OR v_user.email <> v_invite.email THEN
    RAISE EXCEPTION 'fiscus_join_household: the invite is for another email address';
  END IF;
  IF EXISTS (SELECT 1 FROM household_members m
             WHERE m.household_id = fiscus_household() AND m.user_id = v_user.id
               AND m.left_at IS NULL) THEN
    RAISE EXCEPTION 'fiscus_join_household: already a member';
  END IF;

  SELECT coalesce(array_agg(m.color), '{}'), count(*) INTO v_taken, v_active
    FROM household_members m WHERE m.household_id = fiscus_household() AND m.left_at IS NULL;
  SELECT c INTO v_color FROM unnest(p_colors) WITH ORDINALITY AS t(c, n)
    WHERE NOT (c = ANY (v_taken)) ORDER BY n LIMIT 1;
  IF v_color IS NULL THEN
    v_color := p_colors[v_active % array_length(p_colors, 1) + 1];
  END IF;

  INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
    VALUES (uuidv7(), fiscus_household(), v_user.id, v_invite.role, v_user.display_name, v_color)
    RETURNING id INTO v_member;
  UPDATE invites SET accepted_at = now(), accepted_by_user_id = v_user.id WHERE id = v_invite.id;
  RETURN QUERY SELECT v_member, v_invite.id;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_join_household(bytea, text[]) OWNER TO fiscus_steward;
--> statement-breakpoint

-- The invite preview now includes who sent it, which the invitee can't read otherwise.
DROP FUNCTION fiscus_find_invite(bytea);
--> statement-breakpoint
CREATE FUNCTION fiscus_find_invite(p_token_hash bytea)
  RETURNS TABLE (
    id uuid,
    household_id uuid,
    email text,
    role member_role,
    invited_by_member_id uuid,
    household_name text,
    invited_by_name text
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT i.id, i.household_id, i.email, i.role, i.invited_by_member_id, h.name, m.display_name
    FROM invites i
    JOIN households h ON h.id = i.household_id
    LEFT JOIN household_members m ON m.id = i.invited_by_member_id
    WHERE i.token_hash = p_token_hash
      AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
      AND h.status = 'active'
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_find_invite(bytea) OWNER TO fiscus_definer;
--> statement-breakpoint

-- Deleting a category (CAT-03/04): is it used by any of the household's transactions, including
-- ones the caller can't see? Only whether, not which.
CREATE FUNCTION fiscus_category_in_use(p_category uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT fiscus_context_valid() AND EXISTS (
      SELECT 1 FROM transactions t
      WHERE t.category_id = p_category AND t.household_id = fiscus_household()
    )
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_category_in_use(uuid) OWNER TO fiscus_definer;
--> statement-breakpoint

-- ... and moving all of them, seen or not, to another of the household's categories. Only for a
-- member who may delete categories: an owner or member, as the API allows (not a viewer).
CREATE FUNCTION fiscus_reassign_category(p_from uuid, p_to uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_moved integer;
BEGIN
  IF NOT fiscus_context_valid() OR NOT EXISTS (
    SELECT 1 FROM household_members m
    WHERE m.id = fiscus_member() AND m.role IN ('owner', 'member')
  ) THEN
    RAISE EXCEPTION 'fiscus_reassign_category needs a member who may edit categories';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM categories c
                 WHERE c.id = p_from AND c.household_id = fiscus_household())
     OR NOT EXISTS (SELECT 1 FROM categories c
                    WHERE c.id = p_to AND c.household_id = fiscus_household()
                      AND c.id <> p_from AND c.archived_at IS NULL) THEN
    RAISE EXCEPTION 'fiscus_reassign_category: both categories must be the household''s';
  END IF;
  UPDATE transactions t SET category_id = p_to, version = t.version + 1, updated_at = now()
    WHERE t.category_id = p_from AND t.household_id = fiscus_household();
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  RETURN v_moved;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_reassign_category(uuid, uuid) OWNER TO fiscus_steward;
--> statement-breakpoint

-- Verifying the activity history (ADR 0013): the household's whole chain, including events about
-- accounts hidden from the caller, for a member of it. The api only reports whether it's intact.
CREATE FUNCTION fiscus_household_chain() RETURNS SETOF audit_events
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT e.* FROM audit_events e
    WHERE fiscus_context_valid() AND e.scope_id = fiscus_household() AND e.seq IS NOT NULL
    ORDER BY e.seq
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_household_chain() OWNER TO fiscus_definer;
--> statement-breakpoint

-- Household data keys for FieldCrypto, by household: the active version (p_version null) or a
-- given one. Any household's, from any context: they're wrapped with the master key, which is
-- never in the database (ADR 0005 §3), so reading one gives nothing a database dump doesn't.
CREATE FUNCTION fiscus_household_key(p_household uuid, p_version integer)
  RETURNS TABLE (version integer, wrapped_key bytea, master_key_version integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT k.version, k.wrapped_key, k.master_key_version FROM household_keys k
    WHERE k.household_id = p_household
      AND (k.version = p_version OR (p_version IS NULL AND k.retired_at IS NULL))
    ORDER BY k.version DESC
    LIMIT 1
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_household_key(uuid, integer) OWNER TO fiscus_definer;
