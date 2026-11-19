-- Joint-account funding targets (#113, ADR 0006 §7.3). Additive: the previous release ignores the
-- table.
CREATE TYPE "public"."funding_cadence" AS ENUM('weekly', 'every_two_weeks', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."funding_method" AS ENUM('fixed', 'percent_of_income');--> statement-breakpoint
CREATE TABLE "funding_targets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"method" "funding_method" NOT NULL,
	"amount_minor" bigint,
	"percent_bps" integer,
	"cadence" "funding_cadence" NOT NULL,
	"starts_on" date NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funding_targets_household_id_id" UNIQUE("household_id","id"),
	CONSTRAINT "funding_targets_account_member" UNIQUE("account_id","member_id"),
	CONSTRAINT "funding_targets_amount" CHECK (("funding_targets"."method" = 'fixed' AND "funding_targets"."amount_minor" > 0 AND "funding_targets"."percent_bps" IS NULL)
        OR ("funding_targets"."method" = 'percent_of_income' AND "funding_targets"."amount_minor" IS NULL
          AND "funding_targets"."percent_bps" BETWEEN 1 AND 10000)),
	CONSTRAINT "funding_targets_monthly_start" CHECK ("funding_targets"."cadence" <> 'monthly' OR extract(day from "funding_targets"."starts_on") = 1)
);
--> statement-breakpoint
ALTER TABLE "funding_targets" ADD CONSTRAINT "funding_targets_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_targets" ADD CONSTRAINT "funding_targets_household_id_account_id_accounts_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "public"."accounts"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_targets" ADD CONSTRAINT "funding_targets_household_id_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_targets" ADD CONSTRAINT "funding_targets_household_id_created_by_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","created_by_member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "funding_targets_member_id_index" ON "funding_targets" USING btree ("member_id");