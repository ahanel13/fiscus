CREATE TYPE "public"."review_scope" AS ENUM('all', 'uncategorized');--> statement-breakpoint
ALTER TABLE "households" ADD COLUMN "review_scope" "review_scope" DEFAULT 'all' NOT NULL;