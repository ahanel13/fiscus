-- Server → Bank connections' webhook health (#85): how many live Plaid connections there are, and
-- how many of them don't have a working webhook, for an instance admin. As with
-- fiscus_admin_bank_stats (0051), connections are household data under row-level security and the
-- api never enters system context, so this reads them as fiscus_definer after checking that the
-- context's user is an instance admin outside any household. Two counts only (D16): no household,
-- connection or Item is named or identified.
GRANT SELECT (webhook_url, webhook_enabled) ON connections TO fiscus_definer;
--> statement-breakpoint

-- Without a webhook: its Item isn't on p_url (this server's current webhook URL; null when
-- webhooks are off, so then every one), or Plaid hasn't acknowledged the move yet.
CREATE FUNCTION fiscus_admin_plaid_webhook_counts(p_url text) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF session_user = 'fiscus_worker' OR fiscus_household() IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = fiscus_user() AND u.is_instance_admin AND u.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'fiscus_admin_plaid_webhook_counts needs an instance admin in context';
  END IF;
  RETURN (
    SELECT jsonb_build_object(
      'plaid', count(*),
      'withoutWebhook', count(*) FILTER (
        WHERE p_url IS NULL OR webhook_url IS DISTINCT FROM p_url OR NOT webhook_enabled))
    FROM connections WHERE provider = 'plaid' AND status <> 'disconnected'
  );
END
$$;
--> statement-breakpoint
ALTER FUNCTION fiscus_admin_plaid_webhook_counts(text) OWNER TO fiscus_definer;
