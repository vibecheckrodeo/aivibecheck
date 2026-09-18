CREATE TABLE integration_config (name TEXT PRIMARY KEY, encrypted_value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, provider TEXT NOT NULL,
  request_id TEXT REFERENCES requests(id), encrypted_payload TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_expiry ON oauth_states(expires_at);
CREATE TABLE connections (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
  provider TEXT NOT NULL CHECK(provider IN ('github','figma')),
  external_id TEXT NOT NULL, resource TEXT NOT NULL, encrypted_credentials TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','cleanup_due','removed')),
  created_at INTEGER NOT NULL, removed_at INTEGER, last_error TEXT,
  refresh_lock TEXT, refresh_lock_until INTEGER
);
CREATE UNIQUE INDEX active_provider_account ON connections(provider,external_id) WHERE state!='removed';
CREATE UNIQUE INDEX active_request_provider ON connections(request_id,provider) WHERE state='active';
CREATE TABLE github_installation_cleanup (
  installation_id TEXT PRIMARY KEY,
  requested_at INTEGER NOT NULL,
  removed_at INTEGER,
  last_error TEXT
);
