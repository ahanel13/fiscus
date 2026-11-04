-- Who looks after a bill (#121; bills walkthrough D13). Additive: the previous release ignores
-- the column. Checks, hand-over and departures: 0077.
ALTER TABLE "recurring_series" ADD COLUMN "responsible_member_id" uuid;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_household_id_responsible_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","responsible_member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_series_responsible_member_id_index" ON "recurring_series" USING btree ("responsible_member_id");