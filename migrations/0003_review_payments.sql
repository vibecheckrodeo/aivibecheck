ALTER TABLE requests ADD COLUMN review_minutes INTEGER NOT NULL DEFAULT 15 CHECK(review_minutes IN (15,30,60));
CREATE TABLE review_payments (
 id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL REFERENCES requests(id),
 minutes INTEGER NOT NULL CHECK(minutes IN (30,60)),
 from_minutes INTEGER NOT NULL,
 amount_cents INTEGER NOT NULL,
 total_cents INTEGER NOT NULL,
 slot_id TEXT NOT NULL REFERENCES slots(id),
 status TEXT NOT NULL CHECK(status IN ('creating','open','paid','expired')),
 claims_ready INTEGER NOT NULL DEFAULT 0,
 session_id TEXT UNIQUE,
 checkout_url TEXT,
 checkout_expires_at INTEGER NOT NULL,
 stripe_payload TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 paid_at INTEGER
);
CREATE UNIQUE INDEX review_one_pending ON review_payments(request_id) WHERE status IN ('creating','open');
CREATE TABLE slot_claims (
 slot_id TEXT PRIMARY KEY REFERENCES slots(id),
 request_id TEXT NOT NULL REFERENCES requests(id),
 payment_id TEXT REFERENCES review_payments(id),
 state TEXT NOT NULL CHECK(state IN ('held','booked'))
);
CREATE INDEX slot_claims_request ON slot_claims(request_id);

CREATE TRIGGER review_paid_requires_booking BEFORE UPDATE OF status ON review_payments
WHEN NEW.status='paid' AND NOT EXISTS(
 SELECT 1 FROM requests r JOIN slots s ON s.id=NEW.slot_id
 WHERE r.id=NEW.request_id AND r.paid_at IS NOT NULL AND r.booked_slot_id=NEW.slot_id
 AND r.review_minutes>=NEW.minutes AND s.request_id=r.id
 AND (SELECT count(*) FROM slot_claims c JOIN slots b ON b.id=c.slot_id WHERE c.request_id=r.id AND c.state='booked' AND b.starts_at>=s.starts_at AND b.starts_at<s.starts_at+NEW.minutes*60000)=NEW.minutes/15
)
BEGIN SELECT RAISE(ABORT,'Review payment requires the complete reserved booking'); END;
