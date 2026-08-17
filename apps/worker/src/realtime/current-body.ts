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
}

export type CommitCurrentBodyResult =
  | { ok: true; revision: number; contentHash: string }
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
    const updated = await this.database
      .prepare(
        `UPDATE pages
         SET body_md = ?, revision = ?, content_hash = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND status = 'active' AND revision = ?
         RETURNING revision`,
      )
      .bind(
        input.bodyMarkdown,
        revision,
        contentHash,
        new Date(input.committedAt).toISOString(),
        input.workspaceId,
        input.pageId,
        input.baseRevision,
      )
      .first<RevisionRow>();
    if (updated !== null) {
      return { ok: true, revision: updated.revision, contentHash };
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
