-- A proof that a household's history only grew (#264, ADR 0013 §4): from a member's last verified
-- point, the hashes after it, events about accounts hidden from them included. Only positions and
-- hashes leave this function, never what an event was (accounts-and-visibility §6). Rows from
-- p_after (the entry the member verified, whose hash the api compares) up to p_until (the head
-- the api read first), at most p_limit of them.
-- hash_version and leaf (0032) are as append-only as the rest of audit_events: fiscus_app has no
-- UPDATE on the table at all (0003), and a column added later doesn't change that.
CREATE FUNCTION fiscus_household_chain_leaves(p_after bigint, p_until bigint, p_limit integer)
  RETURNS TABLE (seq bigint, entry_hash bytea, leaf bytea, hash_version smallint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT e.seq, e.entry_hash, e.leaf, e.hash_version FROM audit_events e
    WHERE fiscus_context_valid() AND e.scope_id = fiscus_household()
      AND e.seq >= p_after AND e.seq <= p_until
    ORDER BY e.seq
    LIMIT p_limit
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_household_chain_leaves(bigint, bigint, integer) OWNER TO fiscus_definer;
