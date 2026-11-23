-- Consent requests (#265, ADR 0012 §Departures item 5, walkthrough D34): one member asking
-- another to agree, answered within 14 days or expired. Additive: the previous release ignores the
-- table.
CREATE TYPE "public"."consent_request_kind" AS ENUM('income_split');--> statement-breakpoint
CREATE TYPE "public"."consent_request_status" AS ENUM('pending', 'accepted', 'declined', 'withdrawn', 'expired');--> statement-breakpoint
CREATE TABLE "consent_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"kind" "consent_request_kind" NOT NULL,
	"requested_by_member_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"status" "consent_request_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT (now() + interval '14 days') NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "consent_requests_not_yourself" CHECK ("consent_requests"."requested_by_member_id" <> "consent_requests"."member_id"),
	CONSTRAINT "consent_requests_closed" CHECK (("consent_requests"."status" = 'pending') = ("consent_requests"."closed_at" IS NULL)),
	CONSTRAINT "consent_requests_expires" CHECK ("consent_requests"."expires_at" > "consent_requests"."created_at")
);
--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_household_id_requested_by_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","requested_by_member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_household_id_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consent_requests_pending" ON "consent_requests" USING btree ("household_id","kind","member_id") WHERE "consent_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "consent_requests_member_id_index" ON "consent_requests" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "consent_requests_requested_by_member_id_index" ON "consent_requests" USING btree ("requested_by_member_id");