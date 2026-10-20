CREATE TABLE "account_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_groups_member_id_id" UNIQUE("member_id","id"),
	CONSTRAINT "account_groups_name" CHECK (length(btrim("account_groups"."name")) BETWEEN 1 AND 60)
);
--> statement-breakpoint
CREATE TABLE "account_placements" (
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"group_id" uuid,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_placements_member_id_account_id_pk" PRIMARY KEY("member_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "account_groups" ADD CONSTRAINT "account_groups_household_id_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_placements" ADD CONSTRAINT "account_placements_household_id_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_placements" ADD CONSTRAINT "account_placements_household_id_account_id_accounts_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "public"."accounts"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_groups_household_id_member_id_index" ON "account_groups" USING btree ("household_id","member_id");--> statement-breakpoint
CREATE INDEX "account_placements_household_id_member_id_index" ON "account_placements" USING btree ("household_id","member_id");