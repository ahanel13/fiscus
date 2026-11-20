-- Budget month start day (#71, ADR 0011 §4): budget months can start on any day, for mid-month
-- paydays. 1 is the calendar month, so nothing changes for existing households.
ALTER TABLE "households" ADD COLUMN "budget_month_start_day" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "households" ADD CONSTRAINT "households_budget_month_start_day" CHECK ("households"."budget_month_start_day" BETWEEN 1 AND 31);--> statement-breakpoint

-- The history window (#256, 0102) in budget months: a newer member's first month of the
-- household's budget is the budget month their window's first day falls in, from the household's
-- start day (#71, budgeting D32), as budgetMonthOf() and budgetMonthSql() work it out. A day a
-- month doesn't have (29-31) is its last day. With the 1st it's the calendar month, as before.
CREATE OR REPLACE FUNCTION fiscus_budget_window(p_budget uuid) RETURNS date
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT (CASE
      WHEN extract(day FROM w.f) >= least(h.budget_month_start_day,
        extract(day FROM date_trunc('month', w.f) + interval '1 month - 1 day'))
      THEN date_trunc('month', w.f)
      ELSE date_trunc('month', w.f) - interval '1 month' END)::date
    FROM budgets b
    JOIN households h ON h.id = b.household_id
    CROSS JOIN (SELECT fiscus_history_from() AS f) w
    WHERE b.id = p_budget AND b.member_id IS NULL AND w.f IS NOT NULL
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_budget_window(uuid) OWNER TO fiscus_definer;
