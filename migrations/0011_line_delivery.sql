ALTER TABLE bot_events ADD COLUMN line_delivery_state TEXT NOT NULL DEFAULT 'pending'
  CHECK (line_delivery_state IN (
    'pending', 'reply_attempted', 'push_pending', 'push_attempted',
    'delivered', 'permanent_failure'
  ));

ALTER TABLE bot_events ADD COLUMN line_reply_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (line_reply_attempts >= 0);

ALTER TABLE bot_events ADD COLUMN line_delivery_attempt_id TEXT;

CREATE INDEX bot_events_line_delivery_idx
  ON bot_events(provider, line_delivery_state, updated_at);
