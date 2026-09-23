ALTER TABLE requests ADD COLUMN finished_at INTEGER;
ALTER TABLE requests ADD COLUMN purge_after INTEGER;
ALTER TABLE requests ADD COLUMN purged_at INTEGER;
CREATE INDEX requests_purge_after ON requests(purge_after, purged_at);
UPDATE requests SET finished_at=updated_at,purge_after=updated_at+518400000 WHERE status IN ('declined','expired');
