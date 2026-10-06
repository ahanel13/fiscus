CREATE TYPE "public"."import_format" AS ENUM('csv', 'ofx', 'qfx', 'monarch');--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"profile_id" uuid,
	"format" "import_format" NOT NULL,
	"filename" text NOT NULL,
	"transaction_count" integer NOT NULL,
	"balance_count" integer NOT NULL,
	"created_account" boolean DEFAULT false NOT NULL,
	"reverted_at" timestamp with time zone,
	"reverted_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batches_household_id_id" UNIQUE("household_id","id"),
	CONSTRAINT "import_batches_filename" CHECK (length("import_batches"."filename") BETWEEN 1 AND 255)
);
--> statement-breakpoint
CREATE TABLE "import_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"format" "import_format" NOT NULL,
	"headers" text[] NOT NULL,
	"mapping" jsonb NOT NULL,
	"created_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_profiles_household_id_id" UNIQUE("household_id","id"),
	CONSTRAINT "import_profiles_name" CHECK (length(btrim("import_profiles"."name")) BETWEEN 1 AND 60)
);
--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD COLUMN "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_household_id_account_id_accounts_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "public"."accounts"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_household_id_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_profile_id_import_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."import_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_profiles" ADD CONSTRAINT "import_profiles_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_batches_household_id_created_at_index" ON "import_batches" USING btree ("household_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "import_batches_account_id_index" ON "import_batches" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "import_profiles_name" ON "import_profiles" USING btree ("household_id",lower("name"));--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_household_id_import_batch_id_import_batches_household_id_id_fk" FOREIGN KEY ("household_id","import_batch_id") REFERENCES "public"."import_batches"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "balance_snapshots_import_batch_id_index" ON "balance_snapshots" USING btree ("import_batch_id");--> statement-breakpoint
CREATE INDEX "transactions_import_batch_id_index" ON "transactions" USING btree ("import_batch_id");