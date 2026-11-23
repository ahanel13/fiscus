-- Moving out (#253, ADR 0012 §Mechanism): rows move by changing their household, with their ids.
-- Every foreign key that keeps a row in its parent's household (household_id plus the parent's id)
-- becomes DEFERRABLE, still INITIALLY IMMEDIATE: nothing changes for anyone else, and the move job
-- alone defers them (SET CONSTRAINTS ALL DEFERRED), so an account and everything under it can
-- change household in one transaction, statement by statement, and are checked at its commit.
-- A test (member-moves.test.ts) fails on any new key of this kind that isn't deferrable.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass AS tbl
    FROM pg_constraint c
    WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace AND NOT c.condeferrable
      AND cardinality(c.conkey) > 1
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey) AND a.attname = 'household_id'
      )
  LOOP
    EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE', r.tbl, r.conname);
  END LOOP;
END $$;
--> statement-breakpoint

-- The worker runs the move as fiscus_maintenance (BYPASSRLS), the only way across households.
-- It may SET ROLE to it, inside runMaintenance() only (an architecture test checks), without
-- inheriting anything. fiscus_app isn't a member, so the api can't (data model §4.1).
-- Re-asserted after a restore by migrate, as dumps don't keep memberships.
GRANT fiscus_maintenance TO fiscus_worker WITH INHERIT FALSE, SET TRUE;
