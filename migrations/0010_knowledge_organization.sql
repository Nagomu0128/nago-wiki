PRAGMA foreign_keys = ON;

CREATE TABLE user_page_state (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  favorited_at TEXT,
  last_viewed_at TEXT,
  PRIMARY KEY (user_id, page_id),
  CHECK (favorited_at IS NOT NULL OR last_viewed_at IS NOT NULL)
) STRICT, WITHOUT ROWID;

CREATE INDEX user_page_state_recent_idx
  ON user_page_state(user_id, last_viewed_at DESC)
  WHERE last_viewed_at IS NOT NULL;

CREATE INDEX user_page_state_favorite_idx
  ON user_page_state(user_id, favorited_at DESC)
  WHERE favorited_at IS NOT NULL;
