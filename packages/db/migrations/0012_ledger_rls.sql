-- Categories, tags, transactions, attribution, and notes: visibility, invariants, and defaults
-- (docs/design/transactions.md, ADR 0006 §3 F1, ADR 0012, permissions §3 and §4.3–4.6).

-- Text search over transaction names and descriptions (data model §7).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX transactions_search ON transactions
  USING gin (display_name gin_trgm_ops, original_description gin_trgm_ops);
--> statement-breakpoint

GRANT SELECT ON transactions, transaction_attributions TO fiscus_definer;
--> statement-breakpoint

-- The earliest date of shared records the context member sees (ADR 0012): their history_from,
-- else the day they joined, in the household's time zone. Null for system context.
CREATE FUNCTION fiscus_history_from() RETURNS date
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT coalesce(m.history_from, (m.joined_at AT TIME ZONE h.timezone)::date)
    FROM household_members m JOIN households h ON h.id = m.household_id
    WHERE m.id = fiscus_member() AND m.household_id = fiscus_household() AND m.left_at IS NULL
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_history_from() OWNER TO fiscus_definer;
--> statement-breakpoint

-- Transactions attributed to the context member. Attribution shares a transaction with them
-- even from an account they can't see (F1); the API then hides the account. A definer function,
-- so the transactions policy can consult attributions without recursing into their policy.
CREATE FUNCTION fiscus_attributed_to_me() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT ta.transaction_id FROM transaction_attributions ta
    WHERE ta.member_id = fiscus_member() AND ta.household_id = fiscus_household()
      AND fiscus_context_valid()
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_attributed_to_me() OWNER TO fiscus_definer;
--> statement-breakpoint

-- Who paid for the transactions attributed to the context member: the paying account's owners,
-- as members. This is what "Paid by Ada" shows when the account itself is hidden (F1); it
-- reveals people, never the account.
CREATE FUNCTION fiscus_attributed_payers()
  RETURNS TABLE (transaction_id uuid, member_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT t.id, o.member_id
    FROM transactions t JOIN account_owners o ON o.account_id = t.account_id
    WHERE t.id IN (SELECT fiscus_attributed_to_me())
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_attributed_payers() OWNER TO fiscus_definer;
--> statement-breakpoint

-- transactions: owners of the paying account see all of it; full and view-only members see it
-- from their history window on (unless they're part of it); attribution shares it.
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transactions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY transactions_select ON transactions FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid()) AND (
    account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
    OR (
      account_id IN (SELECT account_id FROM fiscus_account_access()
                     WHERE level IN ('full', 'view_only'))
      AND effective_date >= (SELECT fiscus_history_from())
    )
    OR id IN (SELECT fiscus_attributed_to_me())
  )
);
--> statement-breakpoint
-- Owners create and delete; owners and full members change (category, tags, review; TXN-04).
-- Which fields each may change is decided in the domain layer.
CREATE POLICY transactions_insert ON transactions FOR INSERT WITH CHECK (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
);
--> statement-breakpoint
CREATE POLICY transactions_update ON transactions FOR UPDATE
  USING (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid()) AND (
      account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
      OR (
        account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'full')
        AND effective_date >= (SELECT fiscus_history_from())
      )
    )
  )
  WITH CHECK (
    household_id = fiscus_household()
    AND account_id IN (SELECT account_id FROM fiscus_account_access()
                       WHERE level IN ('owner', 'full'))
  );
--> statement-breakpoint
CREATE POLICY transactions_delete ON transactions FOR DELETE USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner')
);
--> statement-breakpoint

-- transaction_attributions: visible with their transaction; set by the paying account's owners.
ALTER TABLE transaction_attributions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transaction_attributions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY transaction_attributions_select ON transaction_attributions FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND transaction_id IN (SELECT id FROM transactions)
);
--> statement-breakpoint
CREATE POLICY transaction_attributions_write ON transaction_attributions FOR ALL
  USING (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND transaction_id IN (
      SELECT t.id FROM transactions t
      WHERE t.account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner'))
  )
  WITH CHECK (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND transaction_id IN (
      SELECT t.id FROM transactions t
      WHERE t.account_id IN (SELECT account_id FROM fiscus_account_access() WHERE level = 'owner'))
  );
--> statement-breakpoint

-- transaction_tags: visible with their transaction; changed by those who can categorize it.
ALTER TABLE transaction_tags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transaction_tags FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY transaction_tags_select ON transaction_tags FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND transaction_id IN (SELECT id FROM transactions)
);
--> statement-breakpoint
CREATE POLICY transaction_tags_write ON transaction_tags FOR ALL
  USING (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND transaction_id IN (
      SELECT t.id FROM transactions t
      WHERE t.account_id IN (SELECT account_id FROM fiscus_account_access()
                             WHERE level IN ('owner', 'full')))
  )
  WITH CHECK (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND transaction_id IN (
      SELECT t.id FROM transactions t
      WHERE t.account_id IN (SELECT account_id FROM fiscus_account_access()
                             WHERE level IN ('owner', 'full')))
  );
--> statement-breakpoint

-- transaction_notes: the shared note goes with its transaction; a private note is its author's
-- alone (NOTE-03/04), even from household owners and system jobs.
ALTER TABLE transaction_notes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transaction_notes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY transaction_notes_all ON transaction_notes FOR ALL
  USING (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND transaction_id IN (SELECT id FROM transactions)
    AND (author_member_id IS NULL OR author_member_id = fiscus_member())
  )
  WITH CHECK (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND transaction_id IN (SELECT id FROM transactions)
    AND (author_member_id IS NULL OR author_member_id = fiscus_member())
  );
--> statement-breakpoint

-- Household-wide taxonomy: every member reads; the API limits writes to owners and members.
ALTER TABLE category_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE category_groups FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY category_groups_household ON category_groups FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE categories FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY categories_household ON categories FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tags FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tags_household ON tags FOR ALL
  USING (household_id = fiscus_household() AND (SELECT fiscus_context_valid()))
  WITH CHECK (household_id = fiscus_household() AND (SELECT fiscus_context_valid()));
--> statement-breakpoint

-- Attribution shares sum to exactly 10 000 when present (no rows = inherit from the owners).
CREATE FUNCTION fiscus_check_attribution() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_txn uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.transaction_id ELSE NEW.transaction_id END;
  v_count int;
  v_total bigint;
BEGIN
  SELECT count(*), coalesce(sum(share_bps), 0) INTO v_count, v_total
    FROM transaction_attributions WHERE transaction_id = v_txn;
  IF v_count > 0 AND v_total <> 10000 THEN
    RAISE EXCEPTION 'attribution shares for % sum to %, not 10000', v_txn, v_total
      USING ERRCODE = 'check_violation', CONSTRAINT = 'transaction_attributions_total';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_check_attribution() OWNER TO fiscus_definer;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER transaction_attributions_total
  AFTER INSERT OR UPDATE OR DELETE ON transaction_attributions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fiscus_check_attribution();
--> statement-breakpoint

-- Spending is attributed to current members only.
CREATE FUNCTION fiscus_check_attribution_member() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM household_members m WHERE m.id = NEW.member_id AND m.left_at IS NULL) THEN
    RAISE EXCEPTION 'member % is not a current member', NEW.member_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'transaction_attributions_member';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_check_attribution_member() OWNER TO fiscus_definer;
--> statement-breakpoint
CREATE TRIGGER transaction_attributions_member BEFORE INSERT OR UPDATE OF member_id
  ON transaction_attributions FOR EACH ROW EXECUTE FUNCTION fiscus_check_attribution_member();
--> statement-breakpoint

-- Splits: one level deep; a split parent's children are on its account, in its currency, and
-- add up to its amount exactly. Checked at commit, so a split can be built in several statements.
CREATE FUNCTION fiscus_check_splits() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_parent uuid;
  p transactions%ROWTYPE;
  v_children int;
  v_sum bigint;
  v_mismatch int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_parent := OLD.parent_id;
  ELSIF NEW.parent_id IS NOT NULL THEN
    v_parent := NEW.parent_id;
  ELSE
    v_parent := NEW.id;
  END IF;
  IF v_parent IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO p FROM transactions WHERE id = v_parent;
  IF NOT FOUND THEN
    RETURN NULL; -- the parent was deleted, and its children with it
  END IF;
  IF p.parent_id IS NOT NULL THEN
    RAISE EXCEPTION 'splits are one level deep'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'transactions_split_depth';
  END IF;
  SELECT count(*), coalesce(sum(amount_minor), 0),
         count(*) FILTER (WHERE account_id <> p.account_id OR currency <> p.currency)
    INTO v_children, v_sum, v_mismatch
    FROM transactions WHERE parent_id = v_parent;
  IF NOT p.has_splits AND v_children > 0 THEN
    RAISE EXCEPTION 'transaction % has split children but is not marked as split', v_parent
      USING ERRCODE = 'check_violation', CONSTRAINT = 'transactions_split_parent';
  END IF;
  IF p.has_splits AND (v_children < 2 OR v_sum <> p.amount_minor OR v_mismatch > 0) THEN
    RAISE EXCEPTION 'split of % must have 2+ parts on its account adding up to %, got % parts totalling %',
      v_parent, p.amount_minor, v_children, v_sum
      USING ERRCODE = 'check_violation', CONSTRAINT = 'transactions_split_total';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_check_splits() OWNER TO fiscus_definer;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER transactions_splits AFTER INSERT OR UPDATE OR DELETE ON transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fiscus_check_splits();
--> statement-breakpoint

-- Every household write records activity (ADR 0013 §1).
CREATE TRIGGER category_groups_mark_write AFTER INSERT OR UPDATE OR DELETE ON category_groups
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint
CREATE TRIGGER categories_mark_write AFTER INSERT OR UPDATE OR DELETE ON categories
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint
CREATE TRIGGER tags_mark_write AFTER INSERT OR UPDATE OR DELETE ON tags
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint
CREATE TRIGGER transactions_mark_write AFTER INSERT OR UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint
CREATE TRIGGER transaction_attributions_mark_write AFTER INSERT OR UPDATE OR DELETE ON transaction_attributions
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint
CREATE TRIGGER transaction_tags_mark_write AFTER INSERT OR UPDATE OR DELETE ON transaction_tags
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint
CREATE TRIGGER transaction_notes_mark_write AFTER INSERT OR UPDATE OR DELETE ON transaction_notes
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint

-- The default categories (transactions design §1): the single source for new households and the
-- backfill below. Runs as the caller, so row-level security applies; does nothing if the
-- household already has categories.
CREATE FUNCTION fiscus_seed_default_categories(p_household uuid) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp
  AS $$
DECLARE
  g record;
  v_group uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM category_groups WHERE household_id = p_household) THEN
    RETURN;
  END IF;
  FOR g IN
    SELECT * FROM (VALUES
      (1, 'Income', 'income', ARRAY['Paychecks', 'Interest', 'Other income'], ARRAY[NULL, NULL, NULL]::text[]),
      (2, 'Home', 'fixed', ARRAY['Rent or mortgage', 'Utilities', 'Internet and phone', 'Home insurance', 'Home maintenance'], ARRAY[NULL, NULL, NULL, NULL, NULL]::text[]),
      (3, 'Food', 'flexible', ARRAY['Groceries', 'Restaurants', 'Coffee'], ARRAY[NULL, NULL, NULL]::text[]),
      (4, 'Transportation', 'flexible', ARRAY['Gas', 'Public transit', 'Parking and tolls', 'Car maintenance', 'Car insurance'], ARRAY[NULL, NULL, NULL, NULL, NULL]::text[]),
      (5, 'Shopping', 'flexible', ARRAY['Clothing', 'Household supplies', 'Electronics'], ARRAY[NULL, NULL, NULL]::text[]),
      (6, 'Health', 'flexible', ARRAY['Medical', 'Pharmacy', 'Fitness'], ARRAY[NULL, NULL, NULL]::text[]),
      (7, 'Fun', 'flexible', ARRAY['Entertainment', 'Subscriptions', 'Hobbies'], ARRAY[NULL, NULL, NULL]::text[]),
      (8, 'Travel', 'non_monthly', ARRAY['Flights', 'Lodging', 'Travel other'], ARRAY[NULL, NULL, NULL]::text[]),
      (9, 'Family and pets', 'flexible', ARRAY['Childcare', 'Kids', 'Pets'], ARRAY[NULL, NULL, NULL]::text[]),
      (10, 'Gifts and giving', 'non_monthly', ARRAY['Gifts', 'Charity'], ARRAY[NULL, NULL]::text[]),
      (11, 'Financial', 'fixed', ARRAY['Loan payments', 'Fees', 'Taxes'], ARRAY[NULL, NULL, NULL]::text[]),
      (12, 'Savings', 'savings', ARRAY['Savings transfers', 'Investments'], ARRAY[NULL, NULL]::text[]),
      (13, 'Transfers', 'transfer', ARRAY['Transfer', 'Settlement'], ARRAY['transfer', 'settlement']::text[]),
      (14, 'Other', 'flexible', ARRAY['Uncategorized', 'Miscellaneous'], ARRAY['uncategorized', NULL]::text[])
    ) AS v(ord, name, kind, names, keys)
    ORDER BY ord
  LOOP
    v_group := uuidv7();
    INSERT INTO category_groups (id, household_id, name, kind, sort_order)
      VALUES (v_group, p_household, g.name, g.kind::category_kind, g.ord);
    INSERT INTO categories (id, household_id, group_id, name, system_key, sort_order)
      SELECT uuidv7(), p_household, v_group, n.name, g.keys[n.i], n.i
      FROM unnest(g.names) WITH ORDINALITY AS n(name, i);
  END LOOP;
END
$$;
--> statement-breakpoint
SELECT fiscus_seed_default_categories(id) FROM households;
