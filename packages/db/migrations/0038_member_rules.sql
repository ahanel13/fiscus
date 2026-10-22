ALTER TABLE "rules" ADD COLUMN "member_id" uuid;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_household_id_member_id_household_members_household_id_id_fk" FOREIGN KEY ("household_id","member_id") REFERENCES "public"."household_members"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rules_member_id_index" ON "rules" USING btree ("member_id");--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_member_author" CHECK ("rules"."member_id" IS NULL OR "rules"."member_id" = "rules"."author_member_id");