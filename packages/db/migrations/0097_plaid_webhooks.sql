-- Plaid webhooks (#84): the receiver's counts, and what each connection's Item has. Additive: the
-- previous release ignores the table and the columns.
CREATE TABLE "plaid_webhook_stats" (
	"hour" timestamp with time zone NOT NULL,
	"credential_set_id" uuid,
	"outcome" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	CONSTRAINT "plaid_webhook_stats_bucket" UNIQUE NULLS NOT DISTINCT("hour","credential_set_id","outcome"),
	CONSTRAINT "plaid_webhook_stats_outcome" CHECK ("plaid_webhook_stats"."outcome" IN ('verified', 'unknown_item', 'missing', 'malformed', 'algorithm', 'stale', 'body_hash', 'unknown_key', 'signature'))
);
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "webhook_url" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "webhook_move_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "sync_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "check_requested_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "connections_requested" ON "connections" USING btree ("id") WHERE "connections"."sync_requested_at" IS NOT NULL OR "connections"."check_requested_at" IS NOT NULL;