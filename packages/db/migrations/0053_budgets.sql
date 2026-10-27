-- Budgets (#98, budgeting walkthrough §1): a scope, its strategy per period, and amounts per
-- category per month. Additive: the previous release ignores these tables.
CREATE TYPE "public"."budget_strategy" AS ENUM('category', 'zero_based', 'percentage', 'flex');--> statement-breakpoint
CREATE TABLE "budget_amounts" (
	"household_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"month" date NOT NULL,
	"category_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_amounts_budget_id_month_category_id_pk" PRIMARY KEY("budget_id","month","category_id"),
	CONSTRAINT "budget_amounts_month" CHECK (extract(day from "budget_amounts"."month") = 1),
	CONSTRAINT "budget_amounts_nonnegative" CHECK ("budget_amounts"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "budget_categories" (
	"household_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"rollover" boolean DEFAULT false NOT NULL,
	"bucket" text,
	"yearly_minor" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_categories_budget_id_category_id_pk" PRIMARY KEY("budget_id","category_id"),
	CONSTRAINT "budget_categories_bucket" CHECK ("budget_categories"."bucket" IS NULL OR length(btrim("budget_categories"."bucket")) BETWEEN 1 AND 40),
	CONSTRAINT "budget_categories_yearly" CHECK ("budget_categories"."yearly_minor" IS NULL OR "budget_categories"."yearly_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "budget_strategies" (
	"household_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"from_month" date NOT NULL,
	"strategy" "budget_strategy" NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_strategies_budget_id_from_month_pk" PRIMARY KEY("budget_id","from_month"),
	CONSTRAINT "budget_strategies_from_month" CHECK (extract(day from "budget_strategies"."from_month") = 1)
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid,
	"starts_month" date NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"field_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_household_id_id" UNIQUE("household_id","id"),
	CONSTRAINT "budgets_scope" UNIQUE NULLS NOT DISTINCT("household_id","member_id"),
	CONSTRAINT "budgets_starts_month" CHECK (extract(day from "budgets"."starts_month") = 1)
);
--> statement-breakpoint
ALTER TABLE "budget_amounts" ADD CONSTRAINT "budget_amounts_household_id_budget_id_budgets_household_id_id_fk" FOREIGN KEY ("household_id","budget_id") REFERENCES "public"."budgets"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_amounts" ADD CONSTRAINT "budget_amounts_household_id_category_id_categories_household_id_id_fk" FOREIGN KEY ("household_id","category_id") REFERENCES "public"."categories"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_categories" ADD CONSTRAINT "budget_categories_household_id_budget_id_budgets_household_id_id_fk" FOREIGN KEY ("household_id","budget_id") REFERENCES "public"."budgets"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_categories" ADD CONSTRAINT "budget_categories_household_id_category_id_categories_household_id_id_fk" FOREIGN KEY ("household_id","category_id") REFERENCES "public"."categories"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_strategies" ADD CONSTRAINT "budget_strategies_household_id_budget_id_budgets_household_id_id_fk" FOREIGN KEY ("household_id","budget_id") REFERENCES "public"."budgets"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_household_id_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_amounts_category_id_index" ON "budget_amounts" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "budget_categories_category_id_index" ON "budget_categories" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "budgets_member_id_index" ON "budgets" USING btree ("member_id");