-- Who has agreed to settle with the fewest transfers (#262, walkthrough D31). Additive: the
-- previous release ignores the table.
CREATE TABLE "settle_up_simplify_consents" (
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settle_up_simplify_consents_household_id_member_id_pk" PRIMARY KEY("household_id","member_id")
);
--> statement-breakpoint
ALTER TABLE "settle_up_simplify_consents" ADD CONSTRAINT "settle_up_simplify_consents_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settle_up_simplify_consents" ADD CONSTRAINT "settle_up_simplify_consents_household_id_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE cascade ON UPDATE no action;