CREATE TABLE "goal_plans" (
	"household_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"month" date NOT NULL,
	"amount_minor" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_plans_goal_id_month_pk" PRIMARY KEY("goal_id","month"),
	CONSTRAINT "goal_plans_month" CHECK (extract(day from "goal_plans"."month") = 1),
	CONSTRAINT "goal_plans_amount" CHECK ("goal_plans"."amount_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "goal_plans" ADD CONSTRAINT "goal_plans_household_id_goal_id_goals_household_id_id_fk" FOREIGN KEY ("household_id","goal_id") REFERENCES "public"."goals"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- goal_plans (G16): a goal's plan by month, seen and changed with its goal.
ALTER TABLE goal_plans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE goal_plans FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY goal_plans_household ON goal_plans FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint
CREATE POLICY goal_plans_goal ON goal_plans AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM goals g WHERE g.id = goal_id))
  WITH CHECK (EXISTS (SELECT 1 FROM goals g WHERE g.id = goal_id));
--> statement-breakpoint
CREATE TRIGGER goal_plans_mark_write AFTER INSERT OR UPDATE OR DELETE ON goal_plans
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint
-- Goals with a plan already have had it since the month they began.
INSERT INTO goal_plans (household_id, goal_id, month, amount_minor)
SELECT g.household_id, g.id, date_trunc('month', g.created_at AT TIME ZONE h.timezone)::date,
  g.plan_minor
FROM goals g JOIN households h ON h.id = g.household_id
WHERE g.plan_minor IS NOT NULL;
