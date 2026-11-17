CREATE TABLE "allowances" (
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"month" date NOT NULL,
	"category_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allowances_household_id_member_id_month_pk" PRIMARY KEY("household_id","member_id","month"),
	CONSTRAINT "allowances_month" CHECK (extract(day from "allowances"."month") = 1),
	CONSTRAINT "allowances_amount" CHECK ("allowances"."amount_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "allowances" ADD CONSTRAINT "allowances_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowances" ADD CONSTRAINT "allowances_household_id_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowances" ADD CONSTRAINT "allowances_household_id_category_id_categories_household_id_id_fk" FOREIGN KEY ("household_id","category_id") REFERENCES "public"."categories"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allowances_member_id_index" ON "allowances" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "allowances_category_id_index" ON "allowances" USING btree ("category_id");