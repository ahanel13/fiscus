-- File imports: who sees and changes import batches and saved mappings (docs/design/imports.md,
-- permissions TXN-09/10).

-- balance_snapshots.import_batch_id → import_batches. Declared here rather than in the schema
-- files, which would otherwise import each other.
ALTER TABLE balance_snapshots ADD CONSTRAINT balance_snapshots_import_batch_fk
  FOREIGN KEY (household_id, import_batch_id) REFERENCES import_batches (household_id, id);
--> statement-breakpoint

-- import_batches: visible to whoever imported it and to anyone who can see the account's
-- transactions; created by the account's owners (TXN-09); reverted by the importer or an owner
-- of the account (TXN-10). Never deleted: a reverted batch is the record that it happened.
ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE import_batches FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY import_batches_select ON import_batches FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid()) AND (
    member_id = fiscus_member()
    OR account_id IN (SELECT account_id FROM fiscus_account_access()
                      WHERE level IN ('owner', 'full', 'view_only'))
  )
);
--> statement-breakpoint
CREATE POLICY import_batches_insert ON import_batches FOR INSERT WITH CHECK (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND member_id = fiscus_member()
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
);
--> statement-breakpoint
CREATE POLICY import_batches_update ON import_batches FOR UPDATE
  USING (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid()) AND (
      member_id = fiscus_member()
      OR account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
    )
  )
  WITH CHECK (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid()) AND (
      member_id = fiscus_member()
      OR account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
    )
  );
--> statement-breakpoint
-- The batch row goes when its account is deleted (cascade); reverting an import that created
-- the account deletes the account, and that cascade needs a delete policy.
CREATE POLICY import_batches_delete ON import_batches FOR DELETE USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
);
--> statement-breakpoint

-- import_profiles: household-wide saved mappings. Every member reads; the API limits writes to
-- owners and members, as for categories.
ALTER TABLE import_profiles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE import_profiles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY import_profiles_household ON import_profiles FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint

CREATE TRIGGER import_batches_mark_write AFTER INSERT OR UPDATE OR DELETE ON import_batches
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint
CREATE TRIGGER import_profiles_mark_write AFTER INSERT OR UPDATE OR DELETE ON import_profiles
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
