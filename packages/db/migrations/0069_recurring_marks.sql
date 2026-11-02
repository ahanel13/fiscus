CREATE TYPE "public"."recurring_mark" AS ENUM('paid', 'skipped');--> statement-breakpoint
CREATE TABLE "recurring_marks" (
	"household_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"due" date NOT NULL,
	"mark" "recurring_mark" NOT NULL,
	"transaction_id" uuid,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_marks_series_id_due_pk" PRIMARY KEY("series_id","due"),
	CONSTRAINT "recurring_marks_transaction" UNIQUE("series_id","transaction_id"),
	CONSTRAINT "recurring_marks_transaction_paid" CHECK ("recurring_marks"."transaction_id" IS NULL OR "recurring_marks"."mark" = 'paid')
);
--> statement-breakpoint
ALTER TABLE "recurring_marks" ADD CONSTRAINT "recurring_marks_household_id_series_id_recurring_series_household_id_id_fk" FOREIGN KEY ("household_id","series_id") REFERENCES "public"."recurring_series"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_marks" ADD CONSTRAINT "recurring_marks_household_id_transaction_id_transactions_household_id_id_fk" FOREIGN KEY ("household_id","transaction_id") REFERENCES "public"."transactions"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_marks" ADD CONSTRAINT "recurring_marks_household_id_created_by_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","created_by_member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_marks_transaction_id_index" ON "recurring_marks" USING btree ("transaction_id");