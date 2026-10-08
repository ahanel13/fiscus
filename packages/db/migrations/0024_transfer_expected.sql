-- Migrations run in one transaction, and earlier ones update transactions, queuing deferred
-- trigger events; Postgres won't alter a table with pending ones. Run them now.
SET CONSTRAINTS ALL IMMEDIATE;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "transfer_expected_account_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "transfer_expected_days" integer;--> statement-breakpoint
CREATE INDEX "transactions_transfer_expected" ON "transactions" USING btree ("transfer_expected_account_id") WHERE "transactions"."transfer_expected_account_id" IS NOT NULL AND "transactions"."transfer_group_id" IS NULL;