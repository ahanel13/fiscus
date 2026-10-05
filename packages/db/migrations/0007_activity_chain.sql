CREATE TABLE "audit_chain_heads" (
	"scope_id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint NOT NULL,
	"head_hash" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "scope_id" uuid GENERATED ALWAYS AS (coalesce(household_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "seq" bigint;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "entry_hash" "bytea";--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "changes_enc" "bytea";--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_scope_seq" ON "audit_events" USING btree ("scope_id","seq") WHERE "audit_events"."seq" IS NOT NULL;