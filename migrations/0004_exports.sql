CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL DEFAULT 'download'
    CHECK (purpose IN ('download', 'backup')),
  retention_class TEXT
    CHECK (retention_class IS NULL OR retention_class IN ('weekly', 'monthly')),
  backup_date TEXT CHECK (backup_date IS NULL OR backup_date GLOB '????-??-??'),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'failed', 'cancelled')),
  r2_key TEXT,
  plan_r2_key TEXT,
  multipart_upload_id TEXT,
  page_count INTEGER NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  archive_size INTEGER CHECK (archive_size IS NULL OR archive_size >= 0),
  archive_hash TEXT CHECK (archive_hash IS NULL OR length(archive_hash) = 64),
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  CHECK (
    (purpose = 'download' AND retention_class IS NULL AND backup_date IS NULL) OR
    (purpose = 'backup' AND retention_class IS NOT NULL AND backup_date IS NOT NULL)
  )
) STRICT;

CREATE INDEX exports_workspace_created_idx
  ON exports(workspace_id, created_at DESC);
CREATE INDEX exports_status_updated_idx ON exports(status, updated_at);
CREATE UNIQUE INDEX exports_workspace_backup_date_unique
  ON exports(workspace_id, backup_date)
  WHERE purpose = 'backup';
