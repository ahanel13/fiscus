ALTER TABLE "goals" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "apr_bps" integer;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "minimum_minor" bigint;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_household_id_account_id_accounts_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "public"."accounts"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goals_account_id_index" ON "goals" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_debt" CHECK (("goals"."kind" = 'pay_down') = ("goals"."account_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_apr" CHECK ("goals"."apr_bps" IS NULL OR "goals"."apr_bps" BETWEEN 0 AND 10000);--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_minimum" CHECK ("goals"."minimum_minor" IS NULL OR "goals"."minimum_minor" >= 0);