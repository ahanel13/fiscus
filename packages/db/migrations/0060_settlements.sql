-- Settle-ups (#112): money one member paid another to square up. Additive: the previous release
-- ignores the table.
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"from_member_id" uuid NOT NULL,
	"to_member_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"date" date NOT NULL,
	"kind" text NOT NULL,
	"transaction_id" uuid,
	"note" text,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlements_household_id_id" UNIQUE("household_id","id"),
	CONSTRAINT "settlements_transaction" UNIQUE("transaction_id"),
	CONSTRAINT "settlements_amount" CHECK ("settlements"."amount_minor" > 0),
	CONSTRAINT "settlements_members" CHECK ("settlements"."from_member_id" <> "settlements"."to_member_id"),
	CONSTRAINT "settlements_note" CHECK ("settlements"."note" IS NULL OR length("settlements"."note") <= 500),
	CONSTRAINT "settlements_kind" CHECK (("settlements"."kind" = 'transfer') = ("settlements"."transaction_id" IS NOT NULL) AND "settlements"."kind" IN ('transfer', 'paid', 'adjustment'))
);
--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_household_id_from_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","from_member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_household_id_to_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","to_member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_household_id_created_by_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","created_by_member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "settlements_from_member_id_index" ON "settlements" USING btree ("from_member_id");--> statement-breakpoint
CREATE INDEX "settlements_to_member_id_index" ON "settlements" USING btree ("to_member_id");