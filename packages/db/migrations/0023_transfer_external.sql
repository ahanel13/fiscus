-- Migrations run in one transaction, and earlier ones update transactions, queuing deferred
-- trigger events; Postgres won't alter a table with pending ones. Run them now.
SET CONSTRAINTS ALL IMMEDIATE;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "transfer_external" boolean DEFAULT false NOT NULL;