-- Migrations run in one transaction, and an earlier one (0018) updates transactions, queuing
-- deferred trigger events; Postgres won't alter a table with pending ones. Run them now.
SET CONSTRAINTS ALL IMMEDIATE;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "transfer_previous_category_id" uuid;--> statement-breakpoint
CREATE INDEX "transactions_transfer_match" ON "transactions" USING btree ("household_id","amount_minor","effective_date") WHERE "transactions"."transfer_group_id" IS NULL AND "transactions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "transactions_transfer_group" ON "transactions" USING btree ("transfer_group_id") WHERE "transactions"."transfer_group_id" IS NOT NULL;