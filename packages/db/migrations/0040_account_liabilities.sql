CREATE TABLE "account_liabilities" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"apr_bps" integer,
	"minimum_payment_minor" bigint,
	"next_due_date" date,
	"last_statement_balance_minor" bigint,
	"last_statement_date" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_liabilities" ADD CONSTRAINT "account_liabilities_household_id_account_id_accounts_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "public"."accounts"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_liabilities_household_id_index" ON "account_liabilities" USING btree ("household_id");