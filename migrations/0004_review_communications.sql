ALTER TABLE requests ADD COLUMN reply TEXT NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN estimated_minutes INTEGER CHECK(estimated_minutes IN (15,30,60));
ALTER TABLE requests ADD COLUMN reply_updated_at INTEGER;
ALTER TABLE requests ADD COLUMN upsell_enabled INTEGER NOT NULL DEFAULT 0 CHECK(upsell_enabled IN (0,1));
ALTER TABLE requests ADD COLUMN upsell_count INTEGER NOT NULL DEFAULT 3 CHECK(upsell_count IN (3,4));
CREATE TABLE email_contacts (
 request_id TEXT PRIMARY KEY REFERENCES requests(id),
 consent_at INTEGER,
 verified_at INTEGER,
 unsubscribed_at INTEGER,
 verification_hash TEXT,
 verification_expires_at INTEGER,
 unsubscribe_hash TEXT,
 encrypted_tokens TEXT NOT NULL DEFAULT '',
 last_marketing_at INTEGER,
 marketing_lease_until INTEGER
);
CREATE TABLE email_suppressions (
 email_hash TEXT PRIMARY KEY,
 reason TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE email_outbox (
 id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL REFERENCES requests(id),
 category TEXT NOT NULL CHECK(category IN ('verification','transactional','marketing')),
 kind TEXT NOT NULL,
 sequence INTEGER,
 subject TEXT NOT NULL,
 message TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 due_at INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','accepted','delivered','bounced','complained','cancelled','review')),
 encrypted_payload TEXT NOT NULL DEFAULT '',
 first_attempt_at INTEGER,
 lease_until INTEGER,
 provider_id TEXT,
 accepted_at INTEGER,
 delivered_at INTEGER,
 checked_at INTEGER,
 last_error TEXT,
 UNIQUE(request_id,kind)
);
CREATE INDEX email_due ON email_outbox(state,due_at);
