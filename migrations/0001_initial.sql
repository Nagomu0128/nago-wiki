PRAGMA foreign_keys = ON;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX users_workspace_email_unique
  ON users(workspace_id, lower(email));
CREATE INDEX users_workspace_status_idx ON users(workspace_id, status);

CREATE TABLE external_identities (
  provider TEXT NOT NULL CHECK (provider IN ('cloudflare_access', 'google', 'discord', 'line')),
  external_subject TEXT NOT NULL CHECK (length(external_subject) BETWEEN 1 AND 512),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (provider, external_subject)
) STRICT, WITHOUT ROWID;

CREATE INDEX external_identities_user_idx ON external_identities(user_id);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id TEXT,
  slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 200),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  body_md TEXT NOT NULL DEFAULT '' CHECK (length(CAST(body_md AS BLOB)) <= 1048576),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  access_mode TEXT NOT NULL DEFAULT 'workspace' CHECK (access_mode IN ('workspace', 'restricted')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trashed')),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  trashed_at TEXT,
  last_mutation_id TEXT,
  UNIQUE (id, workspace_id),
  FOREIGN KEY (parent_id, workspace_id) REFERENCES pages(id, workspace_id) ON DELETE RESTRICT,
  CHECK ((status = 'active' AND trashed_at IS NULL) OR (status = 'trashed' AND trashed_at IS NOT NULL)),
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT;

CREATE UNIQUE INDEX pages_active_sibling_slug_unique
  ON pages(workspace_id, ifnull(parent_id, ''), slug)
  WHERE status = 'active';
CREATE INDEX pages_workspace_parent_idx ON pages(workspace_id, parent_id, status);
CREATE INDEX pages_workspace_updated_idx ON pages(workspace_id, status, updated_at DESC);

CREATE TABLE page_create_idempotency (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL CHECK (length(key_hash) = 64),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key_hash)
) STRICT, WITHOUT ROWID;

CREATE INDEX page_create_idempotency_expires_idx
  ON page_create_idempotency(expires_at);

CREATE TABLE page_acl (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('editor', 'viewer')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (page_id, user_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX page_acl_user_idx ON page_acl(user_id, page_id);

CREATE TABLE page_aliases (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  normalized_path TEXT NOT NULL CHECK (length(normalized_path) BETWEEN 1 AND 4096),
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, normalized_path)
) STRICT, WITHOUT ROWID;

CREATE INDEX page_aliases_page_idx ON page_aliases(page_id);

CREATE TABLE page_links (
  source_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  target_page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  raw_target TEXT NOT NULL CHECK (length(raw_target) BETWEEN 1 AND 4096),
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_page_id, raw_target)
) STRICT, WITHOUT ROWID;

CREATE INDEX page_links_target_idx ON page_links(target_page_id, source_page_id);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  normalized_name TEXT NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, normalized_name)
) STRICT;

CREATE TABLE page_tags (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (page_id, tag_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX page_tags_tag_idx ON page_tags(tag_id, page_id);

CREATE TABLE page_versions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  r2_key TEXT NOT NULL CHECK (length(r2_key) BETWEEN 1 AND 1024),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason IN ('create', 'edit', 'move', 'restore', 'import', 'manual')),
  storage_status TEXT NOT NULL DEFAULT 'pending' CHECK (storage_status IN ('pending', 'ready', 'failed')),
  storage_error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (page_id, revision)
) STRICT;

CREATE INDEX page_versions_page_created_idx ON page_versions(page_id, created_at DESC);

CREATE TABLE page_version_outbox (
  version_id TEXT PRIMARY KEY REFERENCES page_versions(id) ON DELETE CASCADE,
  body_md TEXT NOT NULL CHECK (length(CAST(body_md AS BLOB)) <= 1048576),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX page_version_outbox_available_idx ON page_version_outbox(available_at);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body_md TEXT NOT NULL CHECK (length(CAST(body_md AS BLOB)) BETWEEN 1 AND 65536),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX comments_page_created_idx ON comments(page_id, created_at ASC);

CREATE TABLE mentions (
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  mentioned_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TEXT,
  PRIMARY KEY (comment_id, mentioned_user_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX mentions_user_unread_idx ON mentions(mentioned_user_id, read_at);

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('google_docs', 'markdown', 'pdf', 'public_url', 'paste')),
  source_metadata_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'preview_ready', 'applied', 'failed', 'cancelled')),
  report_r2_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
) STRICT;

CREATE INDEX imports_user_created_idx ON imports(user_id, created_at DESC);
CREATE INDEX imports_status_updated_idx ON imports(status, updated_at);

CREATE TABLE index_state (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  desired_hash TEXT NOT NULL CHECK (length(desired_hash) = 64),
  indexed_hash TEXT CHECK (indexed_hash IS NULL OR length(indexed_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('pending', 'indexed', 'failed', 'deleted')),
  last_error TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX index_state_status_updated_idx ON index_state(status, updated_at);

CREATE TABLE bot_channel_allowlist (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('discord', 'line')),
  external_channel_id TEXT NOT NULL CHECK (length(external_channel_id) BETWEEN 1 AND 512),
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 200),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, provider, external_channel_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX bot_channel_allowlist_provider_enabled_idx
  ON bot_channel_allowlist(provider, enabled, external_channel_id);

CREATE TABLE bot_events (
  provider TEXT NOT NULL CHECK (provider IN ('discord', 'line')),
  event_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('received', 'processing', 'completed', 'failed', 'ignored')),
  response_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, event_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX bot_events_created_idx ON bot_events(created_at);

CREATE TABLE account_link_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64),
  provider TEXT CHECK (provider IS NULL OR provider IN ('discord', 'line')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
) STRICT;

CREATE INDEX account_link_codes_user_idx ON account_link_codes(user_id, created_at DESC);
CREATE INDEX account_link_codes_active_idx ON account_link_codes(expires_at, consumed_at);

CREATE TABLE chat_audit (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('web', 'mcp', 'discord', 'line')),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query TEXT NOT NULL CHECK (length(CAST(query AS BLOB)) <= 16384),
  page_ids_json TEXT NOT NULL DEFAULT '[]',
  answer_summary TEXT NOT NULL DEFAULT '' CHECK (length(CAST(answer_summary AS BLOB)) <= 16384),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX chat_audit_expires_idx ON chat_audit(expires_at);
CREATE INDEX chat_audit_user_created_idx ON chat_audit(user_id, created_at DESC);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 200),
  target_type TEXT NOT NULL CHECK (length(target_type) BETWEEN 1 AND 100),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 512),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX audit_events_target_idx ON audit_events(target_type, target_id, created_at DESC);
CREATE INDEX audit_events_actor_idx ON audit_events(actor_id, created_at DESC);

INSERT INTO workspaces (id, name, created_at)
VALUES ('00000000-0000-7000-8000-000000000001', 'Nago Wiki', '2026-08-18T00:00:00.000Z');
