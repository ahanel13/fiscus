-- Consent to a split by income (#110, ADR 0006 F4): each member's, from a day on. Additive: the
-- previous release ignores the table.
CREATE TYPE "public"."income_basis" AS ENUM('declared', 'actual');--> statement-breakpoint
CREATE TABLE "income_split_consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"basis" "income_basis",
	"declared_monthly_minor" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "income_split_consents_from" UNIQUE("household_id","member_id","effective_from"),
	CONSTRAINT "income_split_consents_declared" CHECK (coalesce("income_split_consents"."basis" = 'declared', false) = ("income_split_consents"."declared_monthly_minor" IS NOT NULL) AND coalesce("income_split_consents"."declared_monthly_minor", 0) >= 0)
);
--> statement-breakpoint
ALTER TABLE "income_split_consents" ADD CONSTRAINT "income_split_consents_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_split_consents" ADD CONSTRAINT "income_split_consents_household_id_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "income_split_consents_member_id_index" ON "income_split_consents" USING btree ("member_id");