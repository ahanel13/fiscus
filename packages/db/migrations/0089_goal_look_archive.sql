ALTER TABLE "goals" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "image" "bytea";--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "image_type" text;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "image_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "archived_progress_minor" bigint;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_color" CHECK ("goals"."color" IS NULL OR "goals"."color" ~ '^#[0-9a-f]{6}$');--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_image" CHECK (("goals"."image" IS NULL) = ("goals"."image_type" IS NULL) AND ("goals"."image" IS NULL OR octet_length("goals"."image") <= 200000));