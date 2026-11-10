-- An account's connection is one in its own household (#409). Left out of #408's migration for a
-- release, because the release before it had api tests that set connection ids naming no
-- connection (upgrades.md §3). Accounts pointing at no connection of theirs let go of it first.
-- Not in the Drizzle schema, which can't express the column list: deleting a connection clears
-- connection_id and keeps the account, as disconnecting does.
UPDATE accounts a SET connection_id = NULL
WHERE a.connection_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM connections c WHERE c.household_id = a.household_id AND c.id = a.connection_id
  );
--> statement-breakpoint
ALTER TABLE accounts ADD CONSTRAINT accounts_connection_fk
  FOREIGN KEY (household_id, connection_id) REFERENCES connections (household_id, id)
  ON DELETE SET NULL (connection_id);
