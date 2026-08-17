export interface CurrentBodySnapshot {
  bodyMarkdown: string;
  revision: number;
  contentHash: string;
}

export interface CommitCurrentBodyInput {
  workspaceId: string;
  pageId: string;
  bodyMarkdown: string;
  baseRevision: number;
  committedAt: number;
  authorId?: string;
  reason?: "edit" | "restore" | "import" | "manual";
}

export type CommitCurrentBodyResult =
  | { ok: true; revision: number; contentHash: string; versionId: string }
  | { ok: false; reason: "conflict"; currentRevision: number };

export interface CurrentBodyAdapter {
  load(
    workspaceId: string,
    pageId: string,
  ): Promise<CurrentBodySnapshot | null>;
  commit(input: CommitCurrentBodyInput): Promise<CommitCurrentBodyResult>;
}

interface CurrentBodyRow {
  body_md: string;
  revision: number;
  content_hash: string;
}

interface RevisionRow {
  revision: number;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class D1CurrentBodyAdapter implements CurrentBodyAdapter {
  public constructor(private readonly database: D1Database) {}

  public async load(
    workspaceId: string,
    pageId: string,
  ): Promise<CurrentBodySnapshot | null> {
    const row = await this.database
      .prepare(
        `SELECT body_md, revision, content_hash
         FROM pages WHERE workspace_id = ? AND id = ? AND status = 'active'`,
      )
      .bind(workspaceId, pageId)
      .first<CurrentBodyRow>();
    return row === null
      ? null
      : {
          bodyMarkdown: row.body_md,
          revision: row.revision,
          contentHash: row.content_hash,
        };
  }

  public async commit(
    input: CommitCurrentBodyInput,
  ): Promise<CommitCurrentBodyResult> {
    const contentHash = await sha256Hex(input.bodyMarkdown);
    const revision = input.baseRevision + 1;
    const updatedAt = new Date(input.committedAt).toISOString();
    const versionId = crypto.randomUUID();
    const results = await this.database.batch([
      this.database.prepare(
        `UPDATE pages
         SET body_md = ?, revision = ?, content_hash = ?, updated_at = ?, last_mutation_id = ?
         WHERE workspace_id = ? AND id = ? AND status = 'active' AND revision = ?
         `,
      )
      .bind(
        input.bodyMarkdown,
        revision,
        contentHash,
        updatedAt,
        versionId,
        input.workspaceId,
        input.pageId,
        input.baseRevision,
      ),
      this.database.prepare(
        `INSERT INTO page_versions
           (id, page_id, revision, r2_key, content_hash, author_id, reason,
            storage_status, storage_error, created_at)
         SELECT ?, id, ?, ?, ?, COALESCE(?, created_by), ?, 'pending', NULL, ?
           FROM pages WHERE id = ? AND revision = ? AND last_mutation_id = ?`,
      ).bind(
        versionId,
        revision,
        `versions/${input.workspaceId}/${input.pageId}/${String(revision)}.md`,
        contentHash,
        input.authorId ?? null,
        input.reason ?? "edit",
        updatedAt,
        input.pageId,
        revision,
        versionId,
      ),
      this.database.prepare(
        `INSERT INTO page_version_outbox
           (version_id, body_md, attempts, available_at, created_at, updated_at)
         SELECT ?, ?, 0, ?, ?, ? FROM page_versions WHERE id = ?`,
      ).bind(
        versionId,
        input.bodyMarkdown,
        updatedAt,
        updatedAt,
        updatedAt,
        versionId,
      ),
      this.database.prepare(
        `INSERT INTO index_state
           (page_id, desired_hash, indexed_hash, status, last_error, updated_at)
         SELECT ?, ?, NULL, 'pending', NULL, ? FROM page_versions WHERE id = ?
         ON CONFLICT(page_id) DO UPDATE SET desired_hash = excluded.desired_hash,
           status = 'pending', last_error = NULL, updated_at = excluded.updated_at`,
      ).bind(input.pageId, contentHash, updatedAt, versionId),
    ]);
    if ((results[0]?.meta.changes ?? 0) === 1) {
      return { ok: true, revision, contentHash, versionId };
    }

    const current = await this.database
      .prepare(
        "SELECT revision FROM pages WHERE workspace_id = ? AND id = ? AND status = 'active'",
      )
      .bind(input.workspaceId, input.pageId)
      .first<RevisionRow>();
    return {
      ok: false,
      reason: "conflict",
      currentRevision: current?.revision ?? input.baseRevision,
    };
  }
}
