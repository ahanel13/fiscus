CREATE TABLE "budget_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"name" text NOT NULL,
	"amounts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"flexible_minor" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_templates_name_length" CHECK (length(btrim("budget_templates"."name")) BETWEEN 1 AND 60),
	CONSTRAINT "budget_templates_flexible" CHECK ("budget_templates"."flexible_minor" IS NULL OR "budget_templates"."flexible_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "budget_templates" ADD CONSTRAINT "budget_templates_household_id_budget_id_budgets_household_id_id_fk" FOREIGN KEY ("household_id","budget_id") REFERENCES "public"."budgets"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_templates_name" ON "budget_templates" USING btree ("budget_id",lower("name"));