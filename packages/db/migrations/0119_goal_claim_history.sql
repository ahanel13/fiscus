-- A savings goal's progress over time (#135, #137; goals and budgets G2, G3, G12, goals walkthrough
-- G17): each claim as it stood when a day ended, and what it was worth then. Progress on any date
-- is the claims as they stood then, so the chart, the pace and "on track" read the claims'
-- history, never balances recomputed after the fact.
--
-- A claim's worth needs its account's balance, and a percentage claim's needs every goal's fixed
-- claims on the account too, some of them someone else's own (G3). So this reads them as a
-- definer, as fiscus_goal_claim_values() does (0088), and gives only what fiscus_goal_claim_values()
-- would have on each day: the goal's own claims and their worth, never a balance, another goal, or
-- an account's name (G7).
--
-- Whoever sees the goal sees its history: the household's, or their own (G15). A newer member sees
-- the household's goals' history from their history window on (#256, 0102); a day before it is left
-- out. Their own goals have no window.

GRANT SELECT ON goal_claim_events, goals, households, balance_snapshots TO fiscus_definer;
--> statement-breakpoint

CREATE FUNCTION fiscus_goal_claim_history(p_goal uuid, p_days date[])
  RETURNS TABLE (day date, account_id uuid, amount_minor bigint, percent_bps integer,
                 value_minor bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    WITH goal AS (
      -- A savings goal the caller sees.
      SELECT g.id, g.member_id, h.timezone
      FROM goals g
      JOIN households h ON h.id = g.household_id
      WHERE g.id = p_goal AND g.household_id = fiscus_household() AND fiscus_context_valid()
        AND g.kind = 'save'
        AND (g.member_id IS NULL OR g.member_id = fiscus_member()
             OR current_setting('app.system', true) = 'on')
    ), days AS (
      -- Each day asked for, and the moment it ends in the household's time zone.
      SELECT DISTINCT d.day, ((d.day + 1)::timestamp AT TIME ZONE goal.timezone) AS until
      FROM goal CROSS JOIN unnest(p_days) AS d(day)
      WHERE goal.member_id IS NOT NULL OR fiscus_history_from() IS NULL
        OR d.day >= fiscus_history_from()
    ), accounts_of AS (
      -- Every account the goal has drawn on keeps its history (G17).
      SELECT DISTINCT e.account_id FROM goal_claim_events e JOIN goal ON goal.id = e.goal_id
    ), claims AS (
      -- Every goal's claim on those accounts as each day ended: the last change up to then.
      SELECT days.day, s.goal_id, s.account_id, s.amount_minor, s.percent_bps
      FROM days
      CROSS JOIN LATERAL (
        SELECT DISTINCT ON (e.goal_id, e.account_id) e.goal_id, e.account_id,
          e.amount_after_minor AS amount_minor, e.percent_after_bps AS percent_bps
        FROM goal_claim_events e
        WHERE e.account_id IN (SELECT a.account_id FROM accounts_of a) AND e.at < days.until
        ORDER BY e.goal_id, e.account_id, e.at DESC, e.id DESC
      ) s
      WHERE s.amount_minor IS NOT NULL OR s.percent_bps IS NOT NULL
    ), balances AS (
      -- The balance as each day ended: the latest snapshot on or before it.
      SELECT days.day, a.account_id,
        greatest(coalesce((SELECT b.balance_minor FROM balance_snapshots b
                           WHERE b.account_id = a.account_id AND b.as_of <= days.day
                           ORDER BY b.as_of DESC LIMIT 1), 0), 0) AS balance
      FROM days CROSS JOIN accounts_of a
    ), totals AS (
      -- Fixed claims are filled first, and percentages share what's left (G3).
      SELECT c.day, c.account_id, max(b.balance) AS balance,
        coalesce(sum(c.amount_minor), 0) AS fixed,
        coalesce(sum(floor(b.balance * c.percent_bps / 10000.0)), 0) AS percent
      FROM claims c
      JOIN balances b ON b.day = c.day AND b.account_id = c.account_id
      GROUP BY c.day, c.account_id
    )
    SELECT c.day, c.account_id, c.amount_minor::bigint, c.percent_bps,
      (CASE
        WHEN c.amount_minor IS NOT NULL THEN c.amount_minor
        WHEN t.percent = 0 THEN 0
        ELSE floor(least(1.0, greatest(t.balance - t.fixed, 0) / t.percent)
                   * floor(t.balance * c.percent_bps / 10000.0))
      END)::bigint
    FROM claims c
    JOIN totals t ON t.day = c.day AND t.account_id = c.account_id
    JOIN goal ON goal.id = c.goal_id
    ORDER BY c.day, c.account_id
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_goal_claim_history(uuid, date[]) OWNER TO fiscus_definer;
