-- Who owns the other side of each transfer in `ids` the caller can see (#40, F1). When that side
-- is in an account the caller can't see, this is what "Transfer to Bea" shows: it names people,
-- never the account or the other transaction.
CREATE FUNCTION fiscus_transfer_counterparts(ids uuid[])
  RETURNS TABLE (transaction_id uuid, member_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT t.id, o.member_id
    FROM transactions t
    JOIN transactions other ON other.transfer_group_id = t.transfer_group_id
      AND other.id <> t.id AND other.deleted_at IS NULL
    JOIN account_owners o ON o.account_id = other.account_id
    WHERE t.id = ANY(ids)
      AND t.household_id = fiscus_household() AND fiscus_context_valid()
      AND t.deleted_at IS NULL AND t.transfer_group_id IS NOT NULL
      AND (t.account_id IN (SELECT account_id FROM fiscus_account_access()
                            WHERE level IN ('owner', 'full', 'view_only'))
           OR t.id IN (SELECT fiscus_attributed_to_me()))
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_transfer_counterparts(uuid[]) OWNER TO fiscus_definer;
