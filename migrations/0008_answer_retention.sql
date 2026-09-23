-- The prepayment estimate in requests.reply is not the delivered paid answer.
ALTER TABLE requests ADD COLUMN answer_text TEXT NOT NULL DEFAULT '';
