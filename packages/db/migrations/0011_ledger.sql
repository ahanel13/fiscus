CREATE TYPE "public"."category_kind" AS ENUM('income', 'fixed', 'flexible', 'non_monthly', 'savings', 'transfer');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('needs_review', 'reviewed');--> statement-breakpoint
CREATE TYPE "public"."transaction_source" AS ENUM('provider', 'import', 'manual');--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"system_key" text,
	"archived_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_household_id_id" UNIQUE("household_id","id"),
	CONSTRAINT "categories_name" CHECK (length(btrim("categories"."name")) BETWEEN 1 AND 60)
);
--> statement-breakpoint
CREATE TABLE "category_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "category_kind" NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_groups_household_id_id" UNIQUE("household_id","id"),
	CONSTRAINT "category_groups_name" CHECK (length(btrim("category_groups"."name")) BETWEEN 1 AND 60)
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_household_id_id" UNIQUE("household_id","id"),
	CONSTRAINT "tags_name" CHECK (length(btrim("tags"."name")) BETWEEN 1 AND 40)
);
--> statement-breakpoint
CREATE TABLE "transaction_attributions" (
	"transaction_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"share_bps" integer NOT NULL,
	CONSTRAINT "transaction_attributions_transaction_id_member_id_pk" PRIMARY KEY("transaction_id","member_id"),
	CONSTRAINT "transaction_attributions_share" CHECK ("transaction_attributions"."share_bps" BETWEEN 1 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "transaction_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"author_member_id" uuid,
	"body_enc" "bytea" NOT NULL,
	"updated_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_tags" (
	"transaction_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	CONSTRAINT "transaction_tags_transaction_id_tag_id_pk" PRIMARY KEY("transaction_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"parent_id" uuid,
	"has_splits" boolean DEFAULT false NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"posted_date" date,
	"authorized_date" date NOT NULL,
	"date_override" date,
	"effective_date" date GENERATED ALWAYS AS (coalesce("transactions"."date_override", "transactions"."posted_date", "transactions"."authorized_date")) STORED NOT NULL,
	"pending" boolean DEFAULT false NOT NULL,
	"original_description" text NOT NULL,
	"display_name" text NOT NULL,
	"category_id" uuid,
	"review_status" "review_status" DEFAULT 'needs_review' NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"transfer_group_id" uuid,
	"is_settlement" boolean DEFAULT false NOT NULL,
	"is_business" boolean,
	"foreign_amount_minor" bigint,
	"foreign_currency" char(3),
	"source" "transaction_source" NOT NULL,
	"provider_transaction_id" text,
	"provider_pending_id" text,
	"import_batch_id" uuid,
	"dedupe_key" text,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"field_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_household_id_id" UNIQUE("household_id","id"),
	CONSTRAINT "transactions_currency" CHECK ("transactions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "transactions_parent" CHECK ("transactions"."parent_id" IS NULL OR "transactions"."has_splits" = false)
);
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_household_id_group_id_category_groups_household_id_id_fk" FOREIGN KEY ("household_id","group_id") REFERENCES "public"."category_groups"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_groups" ADD CONSTRAINT "category_groups_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_attributions" ADD CONSTRAINT "transaction_attributions_household_id_transaction_id_transactions_household_id_id_fk" FOREIGN KEY ("household_id","transaction_id") REFERENCES "public"."transactions"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_attributions" ADD CONSTRAINT "transaction_attributions_household_id_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_notes" ADD CONSTRAINT "transaction_notes_household_id_transaction_id_transactions_household_id_id_fk" FOREIGN KEY ("household_id","transaction_id") REFERENCES "public"."transactions"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_tags" ADD CONSTRAINT "transaction_tags_household_id_transaction_id_transactions_household_id_id_fk" FOREIGN KEY ("household_id","transaction_id") REFERENCES "public"."transactions"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_tags" ADD CONSTRAINT "transaction_tags_household_id_tag_id_tags_household_id_id_fk" FOREIGN KEY ("household_id","tag_id") REFERENCES "public"."tags"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_household_id_account_id_accounts_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "public"."accounts"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_household_id_parent_id_transactions_household_id_id_fk" FOREIGN KEY ("household_id","parent_id") REFERENCES "public"."transactions"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_household_id_category_id_categories_household_id_id_fk" FOREIGN KEY ("household_id","category_id") REFERENCES "public"."categories"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_system_key" ON "categories" USING btree ("household_id","system_key") WHERE "categories"."system_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tags_name" ON "tags" USING btree ("household_id",lower("name"));--> statement-breakpoint
CREATE INDEX "transaction_attributions_member_id_transaction_id_index" ON "transaction_attributions" USING btree ("member_id","transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_notes_shared" ON "transaction_notes" USING btree ("transaction_id") WHERE "transaction_notes"."author_member_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_notes_private" ON "transaction_notes" USING btree ("transaction_id","author_member_id") WHERE "transaction_notes"."author_member_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "transaction_tags_tag_id_index" ON "transaction_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "transactions_list" ON "transactions" USING btree ("household_id","effective_date" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "transactions"."deleted_at" IS NULL AND "transactions"."has_splits" = false;--> statement-breakpoint
CREATE INDEX "transactions_account_id_effective_date_index" ON "transactions" USING btree ("account_id","effective_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_household_id_category_id_effective_date_index" ON "transactions" USING btree ("household_id","category_id","effective_date");--> statement-breakpoint
CREATE INDEX "transactions_parent_id_index" ON "transactions" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "transactions_review_queue" ON "transactions" USING btree ("household_id") WHERE "transactions"."review_status" = 'needs_review' AND "transactions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_provider" ON "transactions" USING btree ("account_id","provider_transaction_id") WHERE "transactions"."provider_transaction_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_dedupe" ON "transactions" USING btree ("account_id","dedupe_key") WHERE "transactions"."source" = 'import' AND "transactions"."dedupe_key" IS NOT NULL;