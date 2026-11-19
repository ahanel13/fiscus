-- Budget templates (#105). Under a budget, so they're seen exactly as it is (0054): the
-- household's budget's by everyone in it, a member's own budget's by them alone. Who may change
-- the household's (owners and members, not viewers) is the api's to enforce, as for the budget.
ALTER TABLE budget_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE budget_templates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY budget_templates_household ON budget_templates FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint
CREATE POLICY budget_templates_budget ON budget_templates AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM budgets b WHERE b.id = budget_id))
  WITH CHECK (EXISTS (SELECT 1 FROM budgets b WHERE b.id = budget_id));
--> statement-breakpoint
CREATE TRIGGER budget_templates_mark_write AFTER INSERT OR UPDATE OR DELETE ON budget_templates
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint
-- Merging a category (0065) carries its amounts in templates to the other one, as it does the
-- budget's. Same signature as before (0106).
GRANT SELECT, UPDATE (amounts, updated_at) ON budget_templates TO fiscus_steward;--> statement-breakpoint
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
  -- Templates' amounts (#105) add into the other's, as the budget's do.
  UPDATE budget_templates t SET
    amounts = (t.amounts - p_from::text) || jsonb_build_object(p_to::text,
      coalesce((t.amounts->>p_to::text)::bigint, 0) + (t.amounts->>p_from::text)::bigint),
    updated_at = now()
    WHERE t.household_id = fiscus_household() AND t.amounts ? p_from::text;
  -- Its own rows go with it when it's deleted (they cascade).
  RETURN v_moved;
END
$$;
