-- A bank's logo and color (#423), from the provider, served from Fiscus's own origin. Additive:
-- the previous release ignores the columns.
ALTER TABLE "institutions" ADD COLUMN "logo_png" "bytea";--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "display_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_color" CHECK ("institutions"."color" IS NULL OR "institutions"."color" ~ '^#[0-9a-f]{6}$');--> statement-breakpoint
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_logo_size" CHECK ("institutions"."logo_png" IS NULL OR octet_length("institutions"."logo_png") <= 65536);