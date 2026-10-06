ALTER TABLE "transactions" ADD COLUMN "import_account_id" uuid;--> statement-breakpoint
-- Imported rows so far are all still in the account they were imported into. Small tables (imports
-- shipped in this release), so the backfill runs here rather than as a job (upgrades.md).
UPDATE "transactions" SET "import_account_id" = "account_id" WHERE "source" = 'import';--> statement-breakpoint
CREATE INDEX "transactions_import_dedupe" ON "transactions" USING btree ("import_account_id","dedupe_key") WHERE "transactions"."import_account_id" IS NOT NULL;