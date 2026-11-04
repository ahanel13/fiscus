CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"detail" text DEFAULT 'full' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_enc" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_channels_member_kind" UNIQUE("member_id","kind"),
	CONSTRAINT "notification_channels_kind" CHECK ("notification_channels"."kind" IN ('email', 'ntfy', 'gotify', 'webhook')),
	CONSTRAINT "notification_channels_detail" CHECK ("notification_channels"."detail" IN ('full', 'summary', 'minimal'))
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error_code" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_channel" UNIQUE("notification_id","channel"),
	CONSTRAINT "notification_deliveries_channel_kind" CHECK ("notification_deliveries"."channel" IN ('email', 'ntfy', 'gotify', 'webhook')),
	CONSTRAINT "notification_deliveries_status" CHECK ("notification_deliveries"."status" IN ('pending', 'sent', 'failed')),
	CONSTRAINT "notification_deliveries_error_code" CHECK ("notification_deliveries"."last_error_code" IS NULL OR "notification_deliveries"."last_error_code" ~ '^[A-Za-z0-9_.:-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channels" text[],
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_member_id_kind_pk" PRIMARY KEY("member_id","kind"),
	CONSTRAINT "notification_preferences_kind" CHECK ("notification_preferences"."kind" ~ '^[a-z][a-z_]{0,39}$'),
	CONSTRAINT "notification_preferences_channels" CHECK ("notification_preferences"."channels" IS NULL OR "notification_preferences"."channels" <@ ARRAY['in_app', 'email', 'ntfy', 'gotify', 'webhook']::text[])
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"summary" text NOT NULL,
	"link" text,
	"test_channel" text,
	"in_app" boolean DEFAULT false NOT NULL,
	"routed_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_household_id_id" UNIQUE("household_id","id"),
	CONSTRAINT "notifications_dedupe" UNIQUE("member_id","dedupe_key"),
	CONSTRAINT "notifications_kind" CHECK ("notifications"."kind" ~ '^[a-z][a-z_]{0,39}$'),
	CONSTRAINT "notifications_dedupe_key" CHECK (length("notifications"."dedupe_key") BETWEEN 1 AND 200),
	CONSTRAINT "notifications_title" CHECK (length("notifications"."title") BETWEEN 1 AND 200),
	CONSTRAINT "notifications_body" CHECK (length("notifications"."body") <= 2000),
	CONSTRAINT "notifications_summary" CHECK (length("notifications"."summary") BETWEEN 1 AND 500),
	CONSTRAINT "notifications_link" CHECK ("notifications"."link" IS NULL OR "notifications"."link" ~ '^/[^/]'),
	CONSTRAINT "notifications_test_channel" CHECK (("notifications"."kind" = 'test') = ("notifications"."test_channel" IS NOT NULL) AND ("notifications"."test_channel" IS NULL OR "notifications"."test_channel" IN ('email', 'ntfy', 'gotify', 'webhook')))
);
--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_household_id_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_household_id_notification_id_notifications_household_id_id_fk" FOREIGN KEY ("household_id","notification_id") REFERENCES "public"."notifications"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_household_id_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_household_id_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_channels_household_id_index" ON "notification_channels" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_due" ON "notification_deliveries" USING btree ("next_attempt_at") WHERE "notification_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "notification_deliveries_household_id_index" ON "notification_deliveries" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "notification_preferences_household_id_index" ON "notification_preferences" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "notifications_member_recent" ON "notifications" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_unrouted" ON "notifications" USING btree ("created_at") WHERE "notifications"."routed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_household_id_index" ON "notifications" USING btree ("household_id");