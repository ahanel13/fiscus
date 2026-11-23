-- Moving out (#253, ADR 0012 step 3, D37): a member's move into a household of their own, kept in
-- the new household. Additive: the previous release ignores the table.
CREATE TYPE "public"."member_move_status" AS ENUM('pending', 'moving', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "member_moves" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"from_household_id" uuid NOT NULL,
	"from_member_id" uuid NOT NULL,
	"status" "member_move_status" DEFAULT 'pending' NOT NULL,
	"step" smallint DEFAULT 0 NOT NULL,
	"plan" jsonb,
	"final_balances" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "member_moves_households" CHECK ("member_moves"."household_id" <> "member_moves"."from_household_id"),
	CONSTRAINT "member_moves_finished" CHECK (("member_moves"."status" IN ('done', 'failed')) = ("member_moves"."finished_at" IS NOT NULL)),
	CONSTRAINT "member_moves_error" CHECK (("member_moves"."status" = 'failed') = ("member_moves"."error_code" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "member_moves" ADD CONSTRAINT "member_moves_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_moves" ADD CONSTRAINT "member_moves_household_id_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_moves_open" ON "member_moves" USING btree ("from_member_id") WHERE "member_moves"."status" IN ('pending', 'moving');--> statement-breakpoint
CREATE INDEX "member_moves_household_id_index" ON "member_moves" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "member_moves_due" ON "member_moves" USING btree ("created_at") WHERE "member_moves"."status" IN ('pending', 'moving');