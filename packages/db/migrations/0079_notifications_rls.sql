-- Notifications (bills walkthrough §7, D15–D20; #125, #126, #130). Each member's channels,
-- preferences and notifications are their own (D15, HH-10): only they read or change them, other
-- members and household owners included. The worker reads them to deliver, in system context.

-- notification_channels: where your notifications go, with their secrets, encrypted.
ALTER TABLE notification_channels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_channels FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notification_channels_own ON notification_channels FOR ALL
  USING (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND (fiscus_is_system() OR member_id = fiscus_member())
  )
  WITH CHECK (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND (fiscus_is_system() OR member_id = fiscus_member())
  );
--> statement-breakpoint
CREATE TRIGGER notification_channels_mark_write AFTER INSERT OR UPDATE OR DELETE ON notification_channels
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint

-- notification_preferences: what you're sent, and when.
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notification_preferences_own ON notification_preferences FOR ALL
  USING (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND (fiscus_is_system() OR member_id = fiscus_member())
  )
  WITH CHECK (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND (fiscus_is_system() OR member_id = fiscus_member())
  );
--> statement-breakpoint
CREATE TRIGGER notification_preferences_mark_write AFTER INSERT OR UPDATE OR DELETE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint

-- notifications: the recipient's only. The worker writes them for anyone in the household; a
-- member writes only their own (a channel's test).
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notifications_own ON notifications FOR ALL
  USING (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND (fiscus_is_system() OR member_id = fiscus_member())
  )
  WITH CHECK (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid())
    AND (fiscus_is_system() OR member_id = fiscus_member())
  );
--> statement-breakpoint
CREATE TRIGGER notifications_mark_write AFTER INSERT OR UPDATE OR DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint

-- notification_deliveries: the worker's bookkeeping. The recipient reads how theirs went (a
-- test's result); only the worker writes them.
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_deliveries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notification_deliveries_select ON notification_deliveries FOR SELECT USING (
  household_id = fiscus_household() AND (SELECT fiscus_context_valid())
  AND (fiscus_is_system() OR notification_id IN (
    SELECT n.id FROM notifications n WHERE n.member_id = fiscus_member()
  ))
);
--> statement-breakpoint
CREATE POLICY notification_deliveries_worker ON notification_deliveries FOR ALL
  USING (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid()) AND fiscus_is_system()
  )
  WITH CHECK (
    household_id = fiscus_household() AND (SELECT fiscus_context_valid()) AND fiscus_is_system()
  );
--> statement-breakpoint
CREATE TRIGGER notification_deliveries_mark_write AFTER INSERT OR UPDATE OR DELETE ON notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION fiscus_mark_household_write();
--> statement-breakpoint

GRANT SELECT ON notifications, notification_deliveries TO fiscus_steward;
--> statement-breakpoint
GRANT UPDATE (lease_until, updated_at) ON notification_deliveries TO fiscus_steward;
--> statement-breakpoint

-- The worker's two queues, as ids only (it then works in each household's system context), and
-- only for a session logged in as fiscus_worker; anyone else gets nothing. Not for a household
-- that's disabled or being deleted.
-- 1. Notifications not yet routed to their recipient's channels, oldest first. Routing twice is
--    harmless (one delivery per notification and channel), so these aren't leased.
CREATE FUNCTION fiscus_unrouted_notifications(p_limit integer)
  RETURNS TABLE (notification_id uuid, household_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT n.id, n.household_id FROM notifications n JOIN households h ON h.id = n.household_id
    WHERE session_user = 'fiscus_worker' AND n.routed_at IS NULL AND h.status = 'active'
    ORDER BY n.created_at
    LIMIT least(greatest(p_limit, 0), 1000)
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_unrouted_notifications(integer) OWNER TO fiscus_steward;
--> statement-breakpoint
-- 2. Deliveries due to be sent (or retried), leased for p_lease. SKIP LOCKED, so two workers
--    never claim the same one; a lease that runs out (a worker stopped mid-send) frees it again.
CREATE FUNCTION fiscus_claim_notification_deliveries(p_limit integer, p_lease interval)
  RETURNS TABLE (delivery_id uuid, household_id uuid)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    WITH due AS (
      SELECT d.id FROM notification_deliveries d JOIN households h ON h.id = d.household_id
      WHERE session_user = 'fiscus_worker'
        AND d.status = 'pending'
        AND d.next_attempt_at <= now()
        AND (d.lease_until IS NULL OR d.lease_until <= now())
        AND h.status = 'active'
      ORDER BY d.next_attempt_at
      LIMIT least(greatest(p_limit, 0), 1000)
      FOR UPDATE OF d SKIP LOCKED
    )
    UPDATE notification_deliveries d
      SET lease_until = now() + greatest(p_lease, interval '0'), updated_at = now()
    FROM due WHERE d.id = due.id
    RETURNING d.id, d.household_id
  $$;
--> statement-breakpoint
ALTER FUNCTION fiscus_claim_notification_deliveries(integer, interval) OWNER TO fiscus_steward;
