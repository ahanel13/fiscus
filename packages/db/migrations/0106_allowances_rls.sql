-- Allowances (#114, budgeting walkthrough D15). A line in the household's budget, so everyone in
-- the household sees each one's amount, as they see that budget (BUD-01). Nothing here says how
-- an allowance was spent: that's only in its member's own budget, which only they see (0054).
-- Who may set one (owners and members, not viewers) is the api's to enforce, as for the budget.
ALTER TABLE allowances ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE allowances FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY allowances_household ON allowances FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint
CREATE TRIGGER allowances_mark_write AFTER INSERT OR UPDATE OR DELETE ON allowances
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint
-- Merging a category (0065) carries its allowances to the other one, as it does the budget's
-- amounts. Same signature as before.
GRANT SELECT, UPDATE (category_id) ON allowances TO fiscus_steward;--> statement-breakpoint
CREATE OR REPLACE FUNCTION fiscus_reassign_category(p_from uuid, p_to uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_moved integer;
BEGIN
  IF NOT fiscus_context_valid() OR NOT EXISTS (
    SELECT 1 FROM household_members m
    WHERE m.id = fiscus_member() AND m.role IN ('owner', 'member')
  ) THEN
    RAISE EXCEPTION 'fiscus_reassign_category needs a member who may edit categories';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM categories c
                 WHERE c.id = p_from AND c.household_id = fiscus_household())
     OR NOT EXISTS (SELECT 1 FROM categories c
                    WHERE c.id = p_to AND c.household_id = fiscus_household()
                      AND c.id <> p_from AND c.archived_at IS NULL) THEN
    RAISE EXCEPTION 'fiscus_reassign_category: both categories must be the household''s';
  END IF;
  UPDATE transactions t SET category_id = p_to, version = t.version + 1, updated_at = now()
    WHERE t.category_id = p_from AND t.household_id = fiscus_household();
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  -- Rules: a condition on it, or setting it, now names the other one.
  UPDATE rules r SET
    conditions = CASE WHEN r.conditions->>'categoryId' = p_from::text
      THEN jsonb_set(r.conditions, '{categoryId}', to_jsonb(p_to::text)) ELSE r.conditions END,
    actions = CASE WHEN r.actions->>'categoryId' = p_from::text
      THEN jsonb_set(r.actions, '{categoryId}', to_jsonb(p_to::text)) ELSE r.actions END,
    version = r.version + 1, updated_at = now()
    WHERE r.household_id = fiscus_household()
      AND (r.conditions->>'categoryId' = p_from::text OR r.actions->>'categoryId' = p_from::text);

  -- Budgets: each month's amount adds into the other's. Its settings (rollover, bucket, yearly
  -- figure) carry over where the other has none; the other's own settings stay.
  INSERT INTO budget_amounts AS a (household_id, budget_id, month, category_id, amount_minor)
    SELECT b.household_id, b.budget_id, b.month, p_to, b.amount_minor FROM budget_amounts b
    WHERE b.category_id = p_from AND b.household_id = fiscus_household()
    ON CONFLICT (budget_id, month, category_id) DO UPDATE
      SET amount_minor = a.amount_minor + EXCLUDED.amount_minor,
          version = a.version + 1, updated_at = now();
  INSERT INTO budget_categories (household_id, budget_id, category_id, rollover, bucket, yearly_minor)
    SELECT b.household_id, b.budget_id, p_to, b.rollover, b.bucket, b.yearly_minor
    FROM budget_categories b
    WHERE b.category_id = p_from AND b.household_id = fiscus_household()
    ON CONFLICT (budget_id, category_id) DO NOTHING;
  -- Money moved to or from it (zero-based Cover and Move money) now moves the other one; a move
  -- between the two would be from a category to itself, so it goes.
  DELETE FROM budget_moves m
    WHERE m.household_id = fiscus_household()
      AND ((m.from_category_id = p_from AND m.to_category_id = p_to)
           OR (m.from_category_id = p_to AND m.to_category_id = p_from));
  UPDATE budget_moves m SET from_category_id = p_to
    WHERE m.from_category_id = p_from AND m.household_id = fiscus_household();
  UPDATE budget_moves m SET to_category_id = p_to
    WHERE m.to_category_id = p_from AND m.household_id = fiscus_household();
  -- Allowances in it are now in the other one.
  UPDATE allowances a SET category_id = p_to
    WHERE a.category_id = p_from AND a.household_id = fiscus_household();
  -- Its own rows go with it when it's deleted (they cascade).
  RETURN v_moved;
END
$$;
