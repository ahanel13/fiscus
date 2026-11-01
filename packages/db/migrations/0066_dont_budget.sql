-- "Don't budget": a spending category left out of one budget, its rows and totals, every month.
-- Additive: the previous release ignores the column.
ALTER TABLE "budget_categories" ADD COLUMN "excluded" boolean DEFAULT false NOT NULL;
