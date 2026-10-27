-- Split rules for shared costs (#109, ADR 0006 §7): the household's default and per-category
-- overrides, each from a month on. Additive: the previous release ignores the table.
CREATE TYPE "public"."split_method" AS ENUM('equal', 'income_proportional', 'fixed_percent', 'fixed_amount');--> statement-breakpoint
CREATE TABLE "split_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"category_id" uuid,
	"effective_from" date NOT NULL,
	"method" "split_method",
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "split_policies_household_id_id" UNIQUE("household_id","id"),
	CONSTRAINT "split_policies_from" UNIQUE NULLS NOT DISTINCT("household_id","category_id","effective_from"),
	CONSTRAINT "split_policies_from_month" CHECK (extract(day from "split_policies"."effective_from") = 1),
	CONSTRAINT "split_policies_default_method" CHECK ("split_policies"."category_id" IS NOT NULL OR "split_policies"."method" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "split_policies" ADD CONSTRAINT "split_policies_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_policies" ADD CONSTRAINT "split_policies_household_id_category_id_categories_household_id_id_fk" FOREIGN KEY ("household_id","category_id") REFERENCES "public"."categories"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_policies" ADD CONSTRAINT "split_policies_household_id_created_by_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","created_by_member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "split_policies_category_id_index" ON "split_policies" USING btree ("category_id");