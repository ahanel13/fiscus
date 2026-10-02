CREATE TYPE "public"."date_basis" AS ENUM('posted', 'authorized');--> statement-breakpoint
CREATE TYPE "public"."finance_style" AS ENUM('combined', 'hybrid', 'separate');--> statement-breakpoint
CREATE TYPE "public"."household_status" AS ENUM('active', 'disabled', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'member', 'viewer');--> statement-breakpoint
CREATE TABLE "household_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid,
	"role" "member_role" NOT NULL,
	"display_name" text NOT NULL,
	"color" text NOT NULL,
	"avatar_url" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "household_members_loginless_role" CHECK ("household_members"."user_id" IS NOT NULL OR "household_members"."role" = 'member')
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"base_currency" char(3) NOT NULL,
	"timezone" text NOT NULL,
	"week_start" smallint DEFAULT 1 NOT NULL,
	"fiscal_year_start_month" smallint DEFAULT 1 NOT NULL,
	"date_basis" date_basis DEFAULT 'posted' NOT NULL,
	"finance_style" "finance_style" DEFAULT 'hybrid' NOT NULL,
	"status" "household_status" DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"field_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "households_week_start" CHECK ("households"."week_start" BETWEEN 0 AND 6),
	CONSTRAINT "households_fiscal_month" CHECK ("households"."fiscal_year_start_month" BETWEEN 1 AND 12)
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "member_role" NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"invited_by_member_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_member_id_household_members_id_fk" FOREIGN KEY ("invited_by_member_id") REFERENCES "public"."household_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "household_members_active_user" ON "household_members" USING btree ("household_id","user_id") WHERE "household_members"."left_at" IS NULL AND "household_members"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "household_members_user_id_index" ON "household_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invites_household_id_index" ON "invites" USING btree ("household_id");--> statement-breakpoint
ALTER TABLE "household_keys" ADD CONSTRAINT "household_keys_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;