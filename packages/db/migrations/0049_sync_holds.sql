-- Possible duplicates held by sync (#80, bank connections walkthrough D7). Additive: the previous
-- release ignores the table.
CREATE TABLE "sync_holds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"provider_transaction_id" text NOT NULL,
	"provider_pending_id" text,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"posted_date" date,
	"authorized_date" date NOT NULL,
	"original_description" text NOT NULL,
	"display_name" text NOT NULL,
	"foreign_amount_minor" bigint,
	"foreign_currency" char(3),
	"candidate_ids" uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_holds_household_id_id" UNIQUE("household_id","id"),
	CONSTRAINT "sync_holds_provider" UNIQUE("account_id","provider_transaction_id"),
	CONSTRAINT "sync_holds_currency" CHECK ("sync_holds"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "sync_holds_nonzero" CHECK ("sync_holds"."amount_minor" <> 0)
);
--> statement-breakpoint
ALTER TABLE "sync_holds" ADD CONSTRAINT "sync_holds_household_id_account_id_accounts_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "public"."accounts"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_holds" ADD CONSTRAINT "sync_holds_household_id_connection_id_connections_household_id_id_fk" FOREIGN KEY ("household_id","connection_id") REFERENCES "public"."connections"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_holds_household_id_index" ON "sync_holds" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "sync_holds_connection_id_index" ON "sync_holds" USING btree ("connection_id");