CREATE TYPE "public"."account_access_level" AS ENUM('balance_only', 'view_only', 'full', 'owner');--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('depository', 'credit', 'loan', 'investment', 'property', 'vehicle', 'crypto', 'other');--> statement-breakpoint
CREATE TYPE "public"."account_visibility" AS ENUM('full', 'view_only', 'balance_only', 'private');--> statement-breakpoint
CREATE TYPE "public"."balance_mode" AS ENUM('transactions', 'value');--> statement-breakpoint
CREATE TYPE "public"."balance_source" AS ENUM('provider', 'computed', 'manual');--> statement-breakpoint
CREATE TABLE "account_owners" (
	"account_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"share_bps" integer NOT NULL,
	CONSTRAINT "account_owners_account_id_member_id_pk" PRIMARY KEY("account_id","member_id"),
	CONSTRAINT "account_owners_share" CHECK ("account_owners"."share_bps" BETWEEN 1 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"connection_id" uuid,
	"provider_account_id" text,
	"name" text NOT NULL,
	"official_name" text,
	"type" "account_type" NOT NULL,
	"subtype" text,
	"currency" char(3) NOT NULL,
	"mask_last4" char(4),
	"account_number_enc" "bytea",
	"visibility" "account_visibility" NOT NULL,
	"balance_mode" "balance_mode" NOT NULL,
	"include_in_net_worth" boolean DEFAULT true NOT NULL,
	"is_business" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"notes_enc" "bytea",
	"closed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"field_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_household_id_id" UNIQUE("household_id","id"),
	CONSTRAINT "accounts_currency" CHECK ("accounts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "accounts_name" CHECK (length(btrim("accounts"."name")) BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE TABLE "balance_snapshots" (
	"account_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"household_id" uuid NOT NULL,
	"balance_minor" bigint NOT NULL,
	"available_minor" bigint,
	"credit_limit_minor" bigint,
	"source" "balance_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balance_snapshots_account_id_as_of_pk" PRIMARY KEY("account_id","as_of")
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_household_id_id" UNIQUE("household_id","id");--> statement-breakpoint
ALTER TABLE "account_owners" ADD CONSTRAINT "account_owners_household_id_account_id_accounts_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "public"."accounts"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_owners" ADD CONSTRAINT "account_owners_household_id_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_household_id_account_id_accounts_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "public"."accounts"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_owners_member_id_index" ON "account_owners" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_account" ON "accounts" USING btree ("connection_id","provider_account_id") WHERE "accounts"."connection_id" IS NOT NULL AND "accounts"."provider_account_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "accounts_household_id_sort_order_index" ON "accounts" USING btree ("household_id","sort_order");--> statement-breakpoint
CREATE INDEX "balance_snapshots_household_id_as_of_index" ON "balance_snapshots" USING btree ("household_id","as_of");--> statement-breakpoint
