ALTER TABLE requests ADD COLUMN review_mode TEXT CHECK(review_mode IN ('answer','call'));
CREATE TABLE deposit_payments (
 id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL REFERENCES requests(id),
 review_mode TEXT NOT NULL CHECK(review_mode IN ('answer','call')),
 slot_id TEXT REFERENCES slots(id) ON DELETE SET NULL,
 status TEXT NOT NULL CHECK(status IN ('creating','open','paid','expired')),
 claims_ready INTEGER NOT NULL DEFAULT 0,
 session_id TEXT UNIQUE,
 checkout_url TEXT,
 checkout_expires_at INTEGER NOT NULL,
 stripe_payload TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 provider_paid_at INTEGER,
 paid_at INTEGER,
 CHECK((review_mode='answer' AND slot_id IS NULL) OR (review_mode='call' AND (slot_id IS NOT NULL OR status='paid')))
);
CREATE UNIQUE INDEX deposit_one_pending ON deposit_payments(request_id) WHERE status IN ('creating','open');
CREATE INDEX deposit_payments_request ON deposit_payments(request_id);
ALTER TABLE slot_claims ADD COLUMN deposit_payment_id TEXT REFERENCES deposit_payments(id);

CREATE TRIGGER deposit_open_requires_creating BEFORE UPDATE OF status ON deposit_payments
WHEN NEW.status='open' AND OLD.status!='creating'
BEGIN SELECT RAISE(ABORT,'Deposit checkout state changed'); END;

CREATE TRIGGER deposit_paid_requires_outcome BEFORE UPDATE OF status ON deposit_payments
WHEN NEW.status='paid' AND (OLD.status NOT IN ('creating','open') OR NOT EXISTS(
 SELECT 1 FROM requests r WHERE r.id=NEW.request_id AND r.paid_at IS NOT NULL
 AND r.review_mode=NEW.review_mode
 AND ((NEW.review_mode='answer' AND r.status='paid' AND r.booked_slot_id IS NULL)
 OR (NEW.review_mode='call' AND r.status='booked' AND r.booked_slot_id=NEW.slot_id AND EXISTS(
 SELECT 1 FROM requests r JOIN slots s ON s.id=NEW.slot_id
 JOIN slot_claims c ON c.slot_id=s.id
 WHERE r.id=NEW.request_id AND s.request_id=r.id
 AND c.request_id=r.id AND c.deposit_payment_id=NEW.id AND c.state='booked')))
))
BEGIN SELECT RAISE(ABORT,'Deposit payment requires its verified outcome'); END;
