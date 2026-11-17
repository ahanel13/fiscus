-- The member history window (#256): the earliest date of household-shared records a member
-- sees. Additive: the previous release ignores the column.
ALTER TABLE "household_members" ADD COLUMN "history_from" date;