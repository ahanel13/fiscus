-- Merchants' logos (#423): global, like institutions, fetched by the worker and served from
-- Fiscus's own origin. Additive: the previous release ignores the table and the column.
CREATE TABLE "merchant_logos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_key" text NOT NULL,
	"source_url" text NOT NULL,
	"image" "bytea",
	"content_type" text,
	"fetched_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_logos_provider_key" UNIQUE("provider","provider_key"),
	CONSTRAINT "merchant_logos_image" CHECK ("merchant_logos"."image" IS NULL OR (octet_length("merchant_logos"."image") <= 65536 AND "merchant_logos"."content_type" IN ('image/png', 'image/jpeg', 'image/webp')))
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "merchant_logo_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_merchant_logo_id_merchant_logos_id_fk" FOREIGN KEY ("merchant_logo_id") REFERENCES "public"."merchant_logos"("id") ON DELETE set null ON UPDATE no action;