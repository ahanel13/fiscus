-- A debt's minimum as a bill (#134, goals and budgets G9, goals walkthrough G23): the day of the
-- month a pay-down goal's minimum is due, entered when the bank gives no due date. Goals' own
-- row-level security (0088) covers it.
ALTER TABLE "goals" ADD COLUMN "due_day" smallint;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_due_day" CHECK ("goals"."due_day" IS NULL OR ("goals"."kind" = 'pay_down' AND "goals"."due_day" BETWEEN 1 AND 31));