-- Flagged attribution changes (#60, ADR 0006 F6). Additive: the previous release ignores the table.
CREATE TABLE "attribution_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"flagged_by_member_id" uuid NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_member_id" uuid,
	CONSTRAINT "attribution_flags_note" CHECK ("attribution_flags"."note" IS NULL OR length("attribution_flags"."note") <= 500),
	CONSTRAINT "attribution_flags_resolved" CHECK (("attribution_flags"."resolved_at" IS NULL) = ("attribution_flags"."resolved_by_member_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "attribution_flags" ADD CONSTRAINT "attribution_flags_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_flags" ADD CONSTRAINT "attribution_flags_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_flags" ADD CONSTRAINT "attribution_flags_household_id_flagged_by_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","flagged_by_member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_flags" ADD CONSTRAINT "attribution_flags_household_id_resolved_by_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","resolved_by_member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attribution_flags_open" ON "attribution_flags" USING btree ("transaction_id") WHERE "attribution_flags"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "attribution_flags_household_id_resolved_at_index" ON "attribution_flags" USING btree ("household_id","resolved_at");