-- Money moved between categories in a zero-based month (#100, D9): Move money and Cover. The
-- same visibility as a budget's amounts (0054): the household's budget to its members, your own
-- to you alone.
ALTER TABLE budget_moves ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE budget_moves FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY budget_moves_household ON budget_moves FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint
CREATE POLICY budget_moves_budget ON budget_moves AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM budgets b WHERE b.id = budget_id))
  WITH CHECK (EXISTS (SELECT 1 FROM budgets b WHERE b.id = budget_id));
--> statement-breakpoint
CREATE TRIGGER budget_moves_mark_write AFTER INSERT OR UPDATE OR DELETE ON budget_moves
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint

-- Merging a category (0065) carries its moves to the other one, including in budgets hidden from
-- the caller. Same signature as before.
GRANT SELECT, DELETE, UPDATE (from_category_id, to_category_id) ON budget_moves TO fiscus_steward;--> statement-breakpoint
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
  -- Its own rows go with it when it's deleted (they cascade).
  RETURN v_moved;
END
$$;
