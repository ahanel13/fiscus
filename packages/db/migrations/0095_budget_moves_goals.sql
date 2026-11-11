ALTER TABLE "budget_moves" DROP CONSTRAINT "budget_moves_two_categories";--> statement-breakpoint
ALTER TABLE "budget_moves" ALTER COLUMN "from_category_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_moves" ALTER COLUMN "to_category_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_moves" ADD COLUMN "from_goal_id" uuid;--> statement-breakpoint
ALTER TABLE "budget_moves" ADD COLUMN "to_goal_id" uuid;--> statement-breakpoint
ALTER TABLE "budget_moves" ADD CONSTRAINT "budget_moves_household_id_from_goal_id_goals_household_id_id_fk" FOREIGN KEY ("household_id","from_goal_id") REFERENCES "public"."goals"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_moves" ADD CONSTRAINT "budget_moves_household_id_to_goal_id_goals_household_id_id_fk" FOREIGN KEY ("household_id","to_goal_id") REFERENCES "public"."goals"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_moves_from_goal_id_index" ON "budget_moves" USING btree ("from_goal_id");--> statement-breakpoint
CREATE INDEX "budget_moves_to_goal_id_index" ON "budget_moves" USING btree ("to_goal_id");--> statement-breakpoint
ALTER TABLE "budget_moves" ADD CONSTRAINT "budget_moves_from" CHECK (num_nonnulls("budget_moves"."from_category_id", "budget_moves"."from_goal_id") = 1);--> statement-breakpoint
ALTER TABLE "budget_moves" ADD CONSTRAINT "budget_moves_to" CHECK (num_nonnulls("budget_moves"."to_category_id", "budget_moves"."to_goal_id") = 1);--> statement-breakpoint
ALTER TABLE "budget_moves" ADD CONSTRAINT "budget_moves_two_lines" CHECK (coalesce("budget_moves"."from_category_id", "budget_moves"."from_goal_id") <> coalesce("budget_moves"."to_category_id", "budget_moves"."to_goal_id"));--> statement-breakpoint
-- A move to or from a goal line names a goal you can see, as a goal's plans do (0092).
CREATE POLICY budget_moves_goal ON budget_moves AS RESTRICTIVE FOR ALL
  USING ((from_goal_id IS NULL OR EXISTS (SELECT 1 FROM goals g WHERE g.id = from_goal_id))
     AND (to_goal_id IS NULL OR EXISTS (SELECT 1 FROM goals g WHERE g.id = to_goal_id)))
  WITH CHECK ((from_goal_id IS NULL OR EXISTS (SELECT 1 FROM goals g WHERE g.id = from_goal_id))
     AND (to_goal_id IS NULL OR EXISTS (SELECT 1 FROM goals g WHERE g.id = to_goal_id)));
