PRAGMA foreign_keys = ON;

-- This row is inserted in the same D1 batch as the imported page. It is the
-- durable idempotency record for the whole import application, and unlike the
-- generic request idempotency table it does not expire after 24 hours.
CREATE TABLE import_applications (
  import_id TEXT PRIMARY KEY REFERENCES imports(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL UNIQUE REFERENCES pages(id) ON DELETE RESTRICT,
  accepted_tags_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(accepted_tags_json)),
  status TEXT NOT NULL DEFAULT 'applying'
    CHECK (status IN ('applying', 'applied')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX import_applications_status_updated_idx
  ON import_applications(status, updated_at);

-- Cleanup completion is separate from imports so API history can be retained
-- after the ephemeral source, preview, report, and staging objects are gone.
CREATE TABLE import_cleanup (
  import_id TEXT PRIMARY KEY REFERENCES imports(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
