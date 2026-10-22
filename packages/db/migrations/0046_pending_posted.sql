-- Pending → posted (#88). Additive: the previous release ignores both.
-- provider_removed_at marks a tombstone the bank made (sync's removals), so a removed pending
-- transaction can come back as its posted version in a later sync; one a person deleted never
-- does. The index finds a pending transaction that already posted, by its old id.
ALTER TABLE "transactions" ADD COLUMN "provider_removed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "transactions_provider_pending" ON "transactions" USING btree ("account_id","provider_pending_id") WHERE "transactions"."provider_pending_id" IS NOT NULL;
