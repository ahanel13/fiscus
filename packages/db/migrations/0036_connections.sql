CREATE TABLE "aggregation_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"client_id" text NOT NULL,
	"secret_enc" "bytea" NOT NULL,
	"env" text NOT NULL,
	"created_by_member_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aggregation_credentials_household_id_id" UNIQUE("household_id","id"),
	CONSTRAINT "aggregation_credentials_provider" CHECK ("aggregation_credentials"."provider" = 'plaid')
);
--> statement-breakpoint
CREATE TABLE "connection_secrets" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"secret_enc" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"owner_member_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"institution_id" uuid,
	"credential_set_id" uuid,
	"provider_item_id" text NOT NULL,
	"provider_env" text,
	"provider_client_id" text,
	"status" text DEFAULT 'setup' NOT NULL,
	"last_error_code" text,
	"first_failed_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"next_sync_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"historical_complete" boolean DEFAULT false NOT NULL,
	"webhook_enabled" boolean DEFAULT false NOT NULL,
	"new_accounts_available" boolean DEFAULT false NOT NULL,
	"disconnect_requested" boolean DEFAULT false NOT NULL,
	"sync_cursor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_household_id_id" UNIQUE("household_id","id"),
	CONSTRAINT "connections_provider_item" UNIQUE("provider","provider_item_id"),
	CONSTRAINT "connections_provider" CHECK ("connections"."provider" IN ('plaid', 'simplefin')),
	CONSTRAINT "connections_status" CHECK ("connections"."status" IN ('setup', 'ok', 'login_required', 'error', 'disconnected'))
);
--> statement-breakpoint
CREATE TABLE "institutions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_institution_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "institutions_provider_institution" UNIQUE("provider","provider_institution_id"),
	CONSTRAINT "institutions_provider" CHECK ("institutions"."provider" IN ('plaid', 'simplefin'))
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "sync_from" date;--> statement-breakpoint
ALTER TABLE "aggregation_credentials" ADD CONSTRAINT "aggregation_credentials_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aggregation_credentials" ADD CONSTRAINT "aggregation_credentials_household_id_created_by_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","created_by_member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_secrets" ADD CONSTRAINT "connection_secrets_household_id_connection_id_connections_household_id_id_fk" FOREIGN KEY ("household_id","connection_id") REFERENCES "public"."connections"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_household_id_owner_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","owner_member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_household_id_credential_set_id_aggregation_credentials_household_id_id_fk" FOREIGN KEY ("household_id","credential_set_id") REFERENCES "public"."aggregation_credentials"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connections_household_id_index" ON "connections" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "connections_due" ON "connections" USING btree ("next_sync_at") WHERE "connections"."next_sync_at" IS NOT NULL;