CREATE TABLE "recurring_dismissals" (
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"key" text NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_dismissals_account_id_direction_key_pk" PRIMARY KEY("account_id","direction","key"),
	CONSTRAINT "recurring_dismissals_direction" CHECK ("recurring_dismissals"."direction" IN ('in', 'out')),
	CONSTRAINT "recurring_dismissals_key" CHECK (length("recurring_dismissals"."key") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "recurring_dismissals" ADD CONSTRAINT "recurring_dismissals_household_id_account_id_accounts_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "public"."accounts"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_dismissals" ADD CONSTRAINT "recurring_dismissals_household_id_created_by_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","created_by_member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE no action ON UPDATE no action;