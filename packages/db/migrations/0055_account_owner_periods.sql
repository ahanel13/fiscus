-- Who owned an account before its current owners (#447), so a transaction without attribution of
-- its own counts for whoever owned its account on its date. Additive: the previous release ignores
-- the table, and with no rows every account's owners count for every date, as before.
CREATE TABLE "account_owner_periods" (
	"account_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"share_bps" integer NOT NULL,
	"valid_from" date,
	"valid_until" date NOT NULL,
	CONSTRAINT "account_owner_periods_account_id_valid_until_member_id_pk" PRIMARY KEY("account_id","valid_until","member_id"),
	CONSTRAINT "account_owner_periods_share" CHECK ("account_owner_periods"."share_bps" BETWEEN 1 AND 10000),
	CONSTRAINT "account_owner_periods_dates" CHECK ("account_owner_periods"."valid_from" IS NULL OR "account_owner_periods"."valid_from" < "account_owner_periods"."valid_until")
);
--> statement-breakpoint
ALTER TABLE "account_owner_periods" ADD CONSTRAINT "account_owner_periods_household_id_account_id_accounts_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "public"."accounts"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_owner_periods" ADD CONSTRAINT "account_owner_periods_household_id_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_owner_periods_member_id_index" ON "account_owner_periods" USING btree ("member_id");