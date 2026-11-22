-- Ownership claims (#267, ADR 0012 §Departures item 7, walkthrough D35): a member asking to become
-- an owner too when no owner has used Fiscus for 30 days, with 30 days' notice. And when each user
-- last used Fiscus, kept when their sessions end. Existing users count as here now, so no claim can
-- start until 30 days after this upgrade. Additive: the previous release ignores both.
CREATE TYPE "public"."ownership_claim_status" AS ENUM('open', 'rejected', 'withdrawn', 'cancelled', 'granted');--> statement-breakpoint
CREATE TABLE "ownership_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"claimant_member_id" uuid NOT NULL,
	"status" "ownership_claim_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone DEFAULT (now() + interval '30 days') NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_member_id" uuid,
	"cancel_reason" text,
	CONSTRAINT "ownership_claims_closed" CHECK (("ownership_claims"."status" = 'open') = ("ownership_claims"."closed_at" IS NULL)),
	CONSTRAINT "ownership_claims_ends" CHECK ("ownership_claims"."ends_at" > "ownership_claims"."created_at"),
	CONSTRAINT "ownership_claims_cancel_reason" CHECK (("ownership_claims"."status" = 'cancelled') = ("ownership_claims"."cancel_reason" IS NOT NULL) AND ("ownership_claims"."cancel_reason" IS NULL OR "ownership_claims"."cancel_reason" IN ('owner_returned', 'claimant_ineligible'))),
	CONSTRAINT "ownership_claims_closed_by" CHECK ("ownership_claims"."closed_by_member_id" IS NULL OR "ownership_claims"."status" IN ('rejected', 'withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_active_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "ownership_claims" ADD CONSTRAINT "ownership_claims_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_claims" ADD CONSTRAINT "ownership_claims_household_id_claimant_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","claimant_member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_claims" ADD CONSTRAINT "ownership_claims_household_id_closed_by_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","closed_by_member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ownership_claims_open" ON "ownership_claims" USING btree ("household_id") WHERE "ownership_claims"."status" = 'open';--> statement-breakpoint
CREATE INDEX "ownership_claims_claimant_member_id_index" ON "ownership_claims" USING btree ("claimant_member_id");