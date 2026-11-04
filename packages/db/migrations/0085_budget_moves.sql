CREATE TABLE "budget_moves" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"month" date NOT NULL,
	"from_category_id" uuid NOT NULL,
	"to_category_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_moves_month" CHECK (extract(day from "budget_moves"."month") = 1),
	CONSTRAINT "budget_moves_positive" CHECK ("budget_moves"."amount_minor" > 0),
	CONSTRAINT "budget_moves_two_categories" CHECK ("budget_moves"."from_category_id" <> "budget_moves"."to_category_id")
);
--> statement-breakpoint
ALTER TABLE "budget_moves" ADD CONSTRAINT "budget_moves_household_id_budget_id_budgets_household_id_id_fk" FOREIGN KEY ("household_id","budget_id") REFERENCES "public"."budgets"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_moves" ADD CONSTRAINT "budget_moves_household_id_from_category_id_categories_household_id_id_fk" FOREIGN KEY ("household_id","from_category_id") REFERENCES "public"."categories"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_moves" ADD CONSTRAINT "budget_moves_household_id_to_category_id_categories_household_id_id_fk" FOREIGN KEY ("household_id","to_category_id") REFERENCES "public"."categories"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_moves_budget_id_month_index" ON "budget_moves" USING btree ("budget_id","month");--> statement-breakpoint
CREATE INDEX "budget_moves_from_category_id_index" ON "budget_moves" USING btree ("from_category_id");--> statement-breakpoint
CREATE INDEX "budget_moves_to_category_id_index" ON "budget_moves" USING btree ("to_category_id");