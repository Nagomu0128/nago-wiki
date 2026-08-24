CREATE TABLE portable_maintenance_state (
  task TEXT PRIMARY KEY,
  cursor TEXT,
  updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
