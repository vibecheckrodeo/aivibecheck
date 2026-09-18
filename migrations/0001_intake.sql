CREATE TABLE IF NOT EXISTS requests (
 id TEXT PRIMARY KEY,
 token_hash TEXT NOT NULL,
 name TEXT NOT NULL,
 email TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 links TEXT NOT NULL DEFAULT '[]',
 access_notes TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','paid','booked','declined','expired')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 completed_at INTEGER,
 expires_at INTEGER,
 approved_at INTEGER,
 scope TEXT NOT NULL DEFAULT '',
 stripe_session_id TEXT,
 paid_at INTEGER,
 deposit_cents INTEGER NOT NULL DEFAULT 2500,
 booked_slot_id TEXT,
 ip_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_expiry ON requests(status, expires_at);
CREATE INDEX IF NOT EXISTS requests_rate ON requests(ip_hash, created_at);
CREATE TABLE IF NOT EXISTS slots (
 id TEXT PRIMARY KEY,
 starts_at INTEGER NOT NULL UNIQUE,
 ends_at INTEGER NOT NULL,
 zoom_url TEXT NOT NULL,
 request_id TEXT UNIQUE REFERENCES requests(id),
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS access_grants (
 id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL REFERENCES requests(id),
 provider TEXT NOT NULL,
 resource TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','cleanup_due','removed')),
 created_at INTEGER NOT NULL,
 removed_at INTEGER,
 last_error TEXT
);
CREATE INDEX IF NOT EXISTS grants_cleanup ON access_grants(state);
CREATE TABLE IF NOT EXISTS audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 request_id TEXT,
 event TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
