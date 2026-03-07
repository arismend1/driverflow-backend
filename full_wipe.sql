-- Full Database Wipe Script
-- Clears all user-related and operational data while preserving schema.

DELETE FROM drivers;
DELETE FROM empresas;
DELETE FROM request_visibility;
DELETE FROM invoices;
DELETE FROM invoice_items;
DELETE FROM events_outbox;
DELETE FROM company_match_prefs;
DELETE FROM webhook_events;
DELETE FROM potential_matches;
DELETE FROM solicitudes;
DELETE FROM ratings;
DELETE FROM credit_notes;
DELETE FROM audit_logs;
DELETE FROM password_resets;
DELETE FROM email_verifications;
DELETE FROM worker_heartbeat;
DELETE FROM driver_profiles;
DELETE FROM company_requirements;
DELETE FROM matches;
DELETE FROM stripe_webhook_events;
DELETE FROM jobs_queue;
DELETE FROM admin_users;
DELETE FROM admin_audit_log;
DELETE FROM weekly_invoices;
DELETE FROM metrics_snapshot;
DELETE FROM tickets;

-- Reset all auto-increment sequences
DELETE FROM sqlite_sequence;

-- Optimize the database
VACUUM;
