CREATE TABLE "member_preferences" (
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_preferences_member_id_key_pk" PRIMARY KEY("member_id","key")
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "effective_authorized_date" date GENERATED ALWAYS AS (coalesce("transactions"."date_override", "transactions"."authorized_date")) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "member_preferences" ADD CONSTRAINT "member_preferences_household_id_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_list_authorized" ON "transactions" USING btree ("household_id","effective_authorized_date" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "transactions"."deleted_at" IS NULL AND "transactions"."has_splits" = false;