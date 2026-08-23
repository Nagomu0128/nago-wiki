PRAGMA foreign_keys = ON;

CREATE TABLE workspace_bot_settings (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('discord', 'line')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, provider)
) STRICT, WITHOUT ROWID;

CREATE TABLE page_acl_revisions (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  last_mutation_id TEXT,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX workspace_bot_settings_enabled_idx
  ON workspace_bot_settings(provider, enabled, workspace_id);
