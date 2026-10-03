-- Row-level security (data model §4, ADR 0005). Every household-scoped table is filtered by the
-- transaction-local context the app sets (withContext). Policies also verify, inside the database,
-- that the context's member really belongs to the household, so an application bug that sets the
-- wrong household still sees nothing. Without context, every policy evaluates to false: fail closed.

-- Owner of the SECURITY DEFINER functions below: it bypasses RLS but can only READ the few
-- tables those functions need, so a bug in a definer function can never write data (least
-- privilege; the broad fiscus_maintenance role is reserved for allow-listed jobs).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fiscus_definer') THEN
    CREATE ROLE fiscus_definer NOLOGIN BYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO fiscus_definer;
--> statement-breakpoint
GRANT SELECT ON households, household_members, invites TO fiscus_definer;
--> statement-breakpoint

-- Context accessors. Empty or missing settings read as NULL.
CREATE FUNCTION fiscus_household() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.household_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION fiscus_member() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.member_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION fiscus_user() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint

-- True when the context names a household AND either it is a system job, or the context's member
-- is an active member of that household belonging to the context's user. SECURITY DEFINER (owned
-- by the read-only fiscus_definer role) so it can read household_members without recursing into
-- its own policies. Policies call it as (SELECT ...) so it runs once per statement, not per row.
CREATE FUNCTION fiscus_context_valid() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT fiscus_household() IS NOT NULL AND (
      current_setting('app.system', true) = 'on'
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
ALTER FUNCTION fiscus_context_valid() OWNER TO fiscus_definer;
--> statement-breakpoint

-- Invite tokens are looked up before the invitee is a member of anything: the one sanctioned
-- cross-household read, limited to a single live invite matching the token hash.
CREATE FUNCTION fiscus_find_invite(p_token_hash bytea)
  RETURNS TABLE (
    id uuid,
    household_id uuid,
    email text,
    role member_role,
    invited_by_member_id uuid,
    household_name text
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT i.id, i.household_id, i.email, i.role, i.invited_by_member_id, h.name
    FROM invites i JOIN households h ON h.id = i.household_id
    WHERE i.token_hash = p_token_hash
      AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
      AND h.status = 'active'
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_find_invite(bytea) OWNER TO fiscus_definer;
--> statement-breakpoint

-- households: readable in its own context, or by any active member listing their memberships.
ALTER TABLE households ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE households FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY households_select ON households FOR SELECT USING (
  (id = fiscus_household() AND (SELECT fiscus_context_valid()))
  OR EXISTS (
    SELECT 1 FROM household_members m
    WHERE m.household_id = households.id AND m.user_id = fiscus_user() AND m.left_at IS NULL
  )
);
--> statement-breakpoint
CREATE POLICY households_insert ON households FOR INSERT
  WITH CHECK (id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint
CREATE POLICY households_update ON households FOR UPDATE
  USING (id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (id = fiscus_household());
--> statement-breakpoint
CREATE POLICY households_delete ON households FOR DELETE
  USING (id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint

-- household_members: the household's members in its context; a user's own memberships anywhere.
ALTER TABLE household_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE household_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY household_members_select ON household_members FOR SELECT USING (
  (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  OR user_id = fiscus_user()
);
--> statement-breakpoint
CREATE POLICY household_members_insert ON household_members FOR INSERT
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint
CREATE POLICY household_members_update ON household_members FOR UPDATE
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household());
--> statement-breakpoint
CREATE POLICY household_members_delete ON household_members FOR DELETE
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint

-- invites and household_keys: their household's context only.
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invites FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY invites_household ON invites FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint
ALTER TABLE household_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE household_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY household_keys_household ON household_keys FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint

-- audit_events: instance-level events (no household) plus the context household's events.
-- UPDATE/DELETE are already revoked from fiscus_app (0003).
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_events_select ON audit_events FOR SELECT USING (
  household_id IS NULL OR (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
);
--> statement-breakpoint
CREATE POLICY audit_events_insert ON audit_events FOR INSERT WITH CHECK (
  household_id IS NULL OR (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
);
