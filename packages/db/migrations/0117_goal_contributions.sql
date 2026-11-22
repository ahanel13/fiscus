-- Who's put in to a goal (#133, goals and budgets G7, G11, budgeting D36): each member's
-- contributions, month by month. A contribution is a claim growing with new money: money moved
-- into one of the goal's accounts (a transfer, and not from another of its own accounts), up to
-- what a fixed claim was raised by that month, and a percentage claim's share of what's left of
-- it. Earmarking money already there isn't anyone's contribution (G11); nor is the market (G12).
-- It's split between the account's owners on the day by their shares (ADR 0006 §2), so a private
-- account's is all its owner's and a joint account's is shared.
--
-- Everyone who sees the goal sees its contributions, as they see its claims: a claim on an account
-- they can't see shows only the claim (G7), so this answers only that much, never the account's
-- balance or its transactions. It reads them as a definer, as fiscus_goal_claim_values() does
-- (0088). A newer member sees the months from their history window on (#256, 0102), except their
-- own.

-- The budget month (`YYYY-MM`) a day is in, from the household's start day (#71, budgeting D32), as
-- budgetMonthOf() and budgetMonthSql() work it out: before the start day (or the month's last day,
-- when it has fewer days), it's the month before's.
CREATE FUNCTION fiscus_budget_month_of(p_day date, p_start_day integer) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
  AS $$
    SELECT to_char(CASE
      WHEN extract(day FROM p_day) >= least(p_start_day,
        extract(day FROM date_trunc('month', p_day) + interval '1 month - 1 day'))
      THEN date_trunc('month', p_day)
      ELSE date_trunc('month', p_day) - interval '1 month' END, 'YYYY-MM')
  $$;
--> statement-breakpoint

GRANT SELECT ON goal_claim_events, goals, households, household_members, accounts,
  account_owners, account_owner_periods, transactions, categories, category_groups
  TO fiscus_definer;
--> statement-breakpoint

CREATE FUNCTION fiscus_goal_contributions(p_goal uuid)
  RETURNS TABLE (month text, member_id uuid, amount_minor bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    WITH goal AS (
      -- A savings goal the caller sees: the household's, or their own (G15).
      SELECT g.id, g.household_id, h.base_currency, h.budget_month_start_day AS start_day,
        h.date_basis, h.timezone
      FROM goals g
      JOIN households h ON h.id = g.household_id
      WHERE g.id = p_goal AND g.household_id = fiscus_household() AND fiscus_context_valid()
        AND g.kind = 'save'
        AND (g.member_id IS NULL OR g.member_id = fiscus_member()
             OR current_setting('app.system', true) = 'on')
    ), events AS (
      -- Every claim the goal has had keeps its history (G17), so this is every account it drew on.
      SELECT e.account_id, e.at, fiscus_budget_month_of((e.at AT TIME ZONE goal.timezone)::date,
          goal.start_day) AS month,
        (e.at AT TIME ZONE goal.timezone)::date AS day,
        coalesce(e.amount_after_minor, 0) - coalesce(e.amount_before_minor, 0) AS fixed_change,
        coalesce(e.percent_after_bps, 0) AS percent_after
      FROM goal_claim_events e
      JOIN goal ON goal.id = e.goal_id
    ), accounts_of AS (
      SELECT DISTINCT account_id FROM events
    ), legs AS (
      -- Money in: linked transfers, and anything filed as a transfer, but not from another of
      -- the goal's own accounts (G4).
      SELECT t.account_id, x.day, fiscus_budget_month_of(x.day, goal.start_day) AS month,
        t.amount_minor
      FROM transactions t
      JOIN goal ON goal.household_id = t.household_id
      CROSS JOIN LATERAL (
        SELECT CASE WHEN goal.date_basis = 'authorized' THEN t.effective_authorized_date
                    ELSE t.effective_date END AS day
      ) x
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN category_groups cg ON cg.id = c.group_id
      WHERE t.account_id IN (SELECT account_id FROM accounts_of)
        AND t.deleted_at IS NULL AND NOT t.excluded AND NOT t.has_splits
        AND t.currency = goal.base_currency AND t.amount_minor > 0
        AND (t.transfer_group_id IS NOT NULL OR cg.kind = 'transfer')
        AND NOT EXISTS (
          SELECT 1 FROM transactions s
          WHERE t.transfer_group_id IS NOT NULL AND s.transfer_group_id = t.transfer_group_id
            AND s.id <> t.id AND s.deleted_at IS NULL
            AND s.account_id IN (SELECT account_id FROM accounts_of)
        )
    ), months AS (
      SELECT account_id, month, sum(amount_minor) AS new_minor, max(day) AS day
      FROM legs GROUP BY account_id, month
    ), raised AS (
      -- What fixed claims were raised by in the month, less what they were lowered by.
      SELECT account_id, month, greatest(sum(fixed_change), 0) AS raised_minor, max(day) AS day
      FROM events GROUP BY account_id, month
    ), worked AS (
      SELECT coalesce(m.account_id, r.account_id) AS account_id,
        coalesce(m.month, r.month) AS month,
        greatest(m.day, r.day) AS day,
        coalesce(m.new_minor, 0) AS new_minor,
        least(coalesce(r.raised_minor, 0), coalesce(m.new_minor, 0)) AS fixed_minor,
        -- The percentage claimed as the month ended (the last change up to then).
        coalesce((SELECT e.percent_after FROM events e
                  WHERE e.account_id = coalesce(m.account_id, r.account_id)
                    AND e.month <= coalesce(m.month, r.month)
                  ORDER BY e.at DESC LIMIT 1), 0) AS percent_bps
      FROM months m
      FULL JOIN raised r ON r.account_id = m.account_id AND r.month = m.month
    ), contributed AS (
      SELECT account_id, month, day,
        fixed_minor + floor((new_minor - fixed_minor) * percent_bps / 10000.0)::bigint AS amount
      FROM worked
    ), shares AS (
      -- Each owner's part on the day, by their share; the running total keeps it exact.
      SELECT c.month, o.member_id,
        floor(c.amount * sum(o.share_bps) OVER w / 10000.0)::bigint
          - floor(c.amount * (sum(o.share_bps) OVER w - o.share_bps) / 10000.0)::bigint AS amount
      FROM contributed c
      CROSS JOIN LATERAL fiscus_owners_on(c.account_id, c.day) o
      WHERE c.amount > 0
      WINDOW w AS (PARTITION BY c.account_id, c.month ORDER BY o.member_id)
    ), since AS (
      -- A newer member's window, as a budget month (0102, 0109).
      SELECT CASE WHEN f IS NULL THEN NULL ELSE fiscus_budget_month_of(f, goal.start_day) END AS month
      FROM goal CROSS JOIN (SELECT fiscus_history_from() AS f) w
    )
    SELECT s.month, s.member_id, sum(s.amount)::bigint
    FROM shares s
    CROSS JOIN since
    WHERE since.month IS NULL OR s.month >= since.month OR s.member_id = fiscus_member()
    GROUP BY s.month, s.member_id
    HAVING sum(s.amount) > 0
    ORDER BY s.month, s.member_id
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_goal_contributions(uuid) OWNER TO fiscus_definer;
