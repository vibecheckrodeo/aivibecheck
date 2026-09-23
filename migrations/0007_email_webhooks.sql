ALTER TABLE email_contacts ADD COLUMN auto_email_enabled INTEGER NOT NULL DEFAULT 0 CHECK(auto_email_enabled IN (0,1));
CREATE TABLE email_delivery_events (
 provider_id TEXT PRIMARY KEY,
 state TEXT NOT NULL CHECK(state IN ('delivered','review','bounced','complained')),
 received_at INTEGER NOT NULL
);
