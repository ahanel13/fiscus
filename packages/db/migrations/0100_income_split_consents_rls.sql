-- income_split_consents (#110, F4): a member's own, read and changed by them alone. Not even
-- household owners or system jobs read them. What the others learn comes only from the two
-- functions below: whether each person has agreed, and the split it makes, never an income.
ALTER TABLE income_split_consents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE income_split_consents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY income_split_consents_own ON income_split_consents FOR ALL
  USING (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND member_id = fiscus_member()
  )
  WITH CHECK (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND member_id = fiscus_member()
  );
--> statement-breakpoint
CREATE TRIGGER income_split_consents_mark_write AFTER INSERT OR UPDATE OR DELETE
  ON income_split_consents FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint
GRANT SELECT ON income_split_consents, categories, category_groups TO fiscus_definer;
--> statement-breakpoint

-- Whether each current member (not viewers) has agreed to a split by income on a day. Says
-- nothing about which income they chose.
CREATE FUNCTION fiscus_income_split_status(p_day date)
  RETURNS TABLE (member_id uuid, consented boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT m.id,
      coalesce((SELECT c.basis IS NOT NULL FROM income_split_consents c
                WHERE c.household_id = m.household_id AND c.member_id = m.id
                  AND c.effective_from <= p_day
                ORDER BY c.effective_from DESC LIMIT 1), false)
    FROM household_members m
    WHERE m.household_id = fiscus_household() AND fiscus_context_valid()
      AND m.left_at IS NULL AND m.role <> 'viewer'
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_income_split_status(date) OWNER TO fiscus_definer;
--> statement-breakpoint

-- The split by income on each of `p_days`, between everyone who had agreed by then: each one's
-- share of their monthly incomes added together, in basis points. Never the incomes themselves.
-- A declared income is the figure entered; an actual one is the income attributed to them over
-- the 3 months before the day's month, a month on average: its attribution, else the account's
-- owners on its date, as everywhere else (#447). All shares are 0 when every income is.
CREATE FUNCTION fiscus_income_split_shares(p_days date[])
  RETURNS TABLE (day date, member_id uuid, share_bps integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    WITH days AS (
      SELECT DISTINCT d AS day FROM unnest(p_days) d
      WHERE fiscus_household() IS NOT NULL AND fiscus_context_valid()
    ), consent AS (
      SELECT days.day, c.member_id, c.basis, c.declared_monthly_minor
      FROM days CROSS JOIN LATERAL (
        SELECT DISTINCT ON (x.member_id) x.member_id, x.basis, x.declared_monthly_minor
        FROM income_split_consents x
        WHERE x.household_id = fiscus_household() AND x.effective_from <= days.day
        ORDER BY x.member_id, x.effective_from DESC
      ) c
      WHERE c.basis IS NOT NULL
    ), months AS (
      SELECT DISTINCT date_trunc('month', day)::date AS month FROM consent WHERE basis = 'actual'
    ), dated AS (
      SELECT t.id, t.account_id, t.effective_date, t.amount_minor,
        CASE WHEN h.date_basis = 'authorized' THEN t.effective_authorized_date
             ELSE t.effective_date END AS day
      FROM transactions t
      JOIN households h ON h.id = t.household_id
      JOIN categories cat ON cat.id = t.category_id
      JOIN category_groups g ON g.id = cat.group_id
      WHERE t.household_id = fiscus_household() AND EXISTS (SELECT 1 FROM months)
        AND t.deleted_at IS NULL AND NOT t.has_splits AND NOT t.excluded
        AND t.currency = h.base_currency AND g.kind = 'income'
    ), income AS (
      SELECT months.month, a.member_id, sum(t.amount_minor * a.share_bps / 10000.0) AS total
      FROM months
      JOIN dated t ON t.day >= (months.month - interval '3 months')::date AND t.day < months.month
      CROSS JOIN LATERAL (
        SELECT ta.member_id, ta.share_bps FROM transaction_attributions ta
        WHERE ta.transaction_id = t.id
        UNION ALL
        SELECT o.member_id, o.share_bps FROM fiscus_owners_on(t.account_id, t.effective_date) o
        WHERE NOT EXISTS (SELECT 1 FROM transaction_attributions ta WHERE ta.transaction_id = t.id)
      ) a
      GROUP BY months.month, a.member_id
    ), figures AS (
      SELECT c.day, c.member_id, greatest(
        CASE WHEN c.basis = 'declared' THEN c.declared_monthly_minor::numeric
             ELSE coalesce((SELECT i.total / 3 FROM income i
                            WHERE i.month = date_trunc('month', c.day)::date
                              AND i.member_id = c.member_id), 0) END, 0) AS monthly
      FROM consent c
    )
    SELECT f.day, f.member_id,
      CASE WHEN sum(f.monthly) OVER w = 0 THEN 0
           ELSE round(f.monthly * 10000 / sum(f.monthly) OVER w)::integer END
    FROM figures f
    WINDOW w AS (PARTITION BY f.day)
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_income_split_shares(date[]) OWNER TO fiscus_definer;
