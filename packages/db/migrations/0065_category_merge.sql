-- Deleting a category into another merges it (CAT-03/04): besides its transactions, the rules
-- that set or look for it now use the other one, and its budget amounts add into the other's,
-- month by month. Everyone's, including members' own rules and budgets hidden from the caller.
-- Same signatures as before, so the previous release keeps working against this schema.
GRANT UPDATE (conditions, actions, version, updated_at) ON rules TO fiscus_steward;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (amount_minor, version, updated_at) ON budget_amounts TO fiscus_steward;--> statement-breakpoint
GRANT SELECT, INSERT ON budget_categories TO fiscus_steward;--> statement-breakpoint
GRANT SELECT ON budget_amounts TO fiscus_definer;--> statement-breakpoint

-- In use: on a transaction, in a rule, or in a budget, so deleting it asks where those go.
CREATE OR REPLACE FUNCTION fiscus_category_in_use(p_category uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT fiscus_context_valid() AND (
      EXISTS (
        SELECT 1 FROM transactions t
        WHERE t.category_id = p_category AND t.household_id = fiscus_household()
      ) OR EXISTS (
        SELECT 1 FROM rules r
        WHERE r.household_id = fiscus_household()
          AND (r.conditions->>'categoryId' = p_category::text
               OR r.actions->>'categoryId' = p_category::text)
      ) OR EXISTS (
        SELECT 1 FROM budget_amounts a
        WHERE a.category_id = p_category AND a.household_id = fiscus_household()
      )
    )
  $$;--> statement-breakpoint

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
  -- Its own rows go with it when it's deleted (they cascade).
  RETURN v_moved;
END
$$;
