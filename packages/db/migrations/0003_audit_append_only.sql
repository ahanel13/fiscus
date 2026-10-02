-- The audit log is append-only for services (ADR 0005 §4): fiscus_app may insert and read
-- events but never change or remove them. Retention purges run as fiscus_maintenance.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM fiscus_app;
