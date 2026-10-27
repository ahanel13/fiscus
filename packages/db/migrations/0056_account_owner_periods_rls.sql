-- account_owner_periods (#447): visible with the account, as account_owners are, and changed only
-- by whoever may change the account's owners.
ALTER TABLE account_owner_periods ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE account_owner_periods FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY account_owner_periods_select ON account_owner_periods FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND account_id IN (SELECT account_id FROM fiscus_account_access())
);
--> statement-breakpoint
CREATE POLICY account_owner_periods_insert ON account_owner_periods FOR INSERT WITH CHECK (
  household_id = fiscus_household() AND fiscus_can_manage_owners(account_id)
);
--> statement-breakpoint
CREATE POLICY account_owner_periods_delete ON account_owner_periods FOR DELETE USING (
  household_id = fiscus_household() AND fiscus_can_manage_owners(account_id)
);
--> statement-breakpoint
CREATE TRIGGER account_owner_periods_mark_write AFTER INSERT OR UPDATE OR DELETE
  ON account_owner_periods FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint
GRANT SELECT ON account_owner_periods TO fiscus_definer;
--> statement-breakpoint

-- Who owned an account on a date: the period covering it, else today's owners. Runs with the
-- caller's rights, so it shows only what the caller may see of the account's owners; the definer
-- functions below call it with theirs.
CREATE FUNCTION fiscus_owners_on(p_account uuid, p_date date)
  RETURNS TABLE (member_id uuid, share_bps integer)
  LANGUAGE sql STABLE SET search_path = public, pg_temp
  AS $$
    SELECT p.member_id, p.share_bps FROM account_owner_periods p
    WHERE p.account_id = p_account AND p_date < p.valid_until
      AND (p.valid_from IS NULL OR p.valid_from <= p_date)
    UNION ALL
    SELECT o.member_id, o.share_bps FROM account_owners o
    WHERE o.account_id = p_account
      AND NOT EXISTS (SELECT 1 FROM account_owner_periods p
                      WHERE p.account_id = p_account AND p_date < p.valid_until
                        AND (p.valid_from IS NULL OR p.valid_from <= p_date))
  $$;
--> statement-breakpoint

-- "Paid by" (F1) and "Transfer to" name whoever owned the paying account on the transaction's
-- date, as its attribution does. Unchanged for accounts without periods.
CREATE OR REPLACE FUNCTION fiscus_attributed_payers()
  RETURNS TABLE (transaction_id uuid, member_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT t.id, o.member_id
    FROM transactions t, LATERAL fiscus_owners_on(t.account_id, t.effective_date) o
    WHERE t.id IN (SELECT fiscus_attributed_to_me())
  $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fiscus_transfer_counterparts(ids uuid[])
  RETURNS TABLE (transaction_id uuid, member_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT t.id, o.member_id
    FROM transactions t
    JOIN transactions other ON other.transfer_group_id = t.transfer_group_id
      AND other.id <> t.id AND other.deleted_at IS NULL
    CROSS JOIN LATERAL fiscus_owners_on(other.account_id, other.effective_date) o
    WHERE t.id = ANY(ids)
      AND t.household_id = fiscus_household() AND fiscus_context_valid()
      AND t.deleted_at IS NULL AND t.transfer_group_id IS NOT NULL
      AND (t.account_id IN (SELECT account_id FROM fiscus_account_access()
                            WHERE level IN ('owner', 'full', 'view_only'))
           OR t.id IN (SELECT fiscus_attributed_to_me()))
  $$;
