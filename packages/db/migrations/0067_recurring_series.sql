CREATE TYPE "public"."recurring_kind" AS ENUM('bill', 'subscription', 'income', 'transfer');--> statement-breakpoint
CREATE TABLE "recurring_series" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "recurring_kind" NOT NULL,
	"match" jsonb NOT NULL,
	"schedule" jsonb NOT NULL,
	"window_days" integer DEFAULT 3 NOT NULL,
	"ended_on" date,
	"created_by_member_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"field_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_series_household_id_id" UNIQUE("household_id","id"),
	CONSTRAINT "recurring_series_name" CHECK (length(btrim("recurring_series"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "recurring_series_window" CHECK ("recurring_series"."window_days" BETWEEN 0 AND 15)
);
--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_household_id_account_id_accounts_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "public"."accounts"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_household_id_created_by_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","created_by_member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_series_account_id_index" ON "recurring_series" USING btree ("account_id");