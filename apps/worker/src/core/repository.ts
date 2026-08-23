import { normalizeWikiPath } from "@nago-wiki/shared";
import type {
  AuthenticatedIdentity,
  Comment,
  Page,
  PagePermission,
  PageTreeNode,
  PageVersion,
  User,
} from "@nago-wiki/shared";
import type { AccessJwtClaims } from "../auth/jwt";
import { ApiProblem, isD1UniqueConstraintError } from "./errors";
import { createUuidV7 } from "./ids";

export const DEFAULT_WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";

interface UserRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  email: string;
  display_name: string;
  role: "owner" | "editor" | "viewer";
  status: "active" | "suspended";
  created_at: string;
  updated_at: string;
}

interface PageRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  slug: string;
  title: string;
  body_md: string;
  revision: number;
  content_hash: string;
  access_mode: "workspace" | "restricted";
  status: "active" | "trashed";
  created_by: string;
  created_at: string;
  updated_at: string;
  trashed_at: string | null;
}

interface PageSummaryRow extends Record<string, unknown> {
  id: string;
  parent_id: string | null;
  slug: string;
  title: string;
  access_mode: "workspace" | "restricted";
  updated_at: string;
}

interface PageVersionRow extends Record<string, unknown> {
  id: string;
  page_id: string;
  revision: number;
  r2_key: string;
  content_hash: string;
  author_id: string;
  reason: "create" | "edit" | "move" | "restore" | "import" | "manual";
  storage_status: "pending" | "ready" | "failed";
  created_at: string;
}

interface CommentRow extends Record<string, unknown> {
  id: string;
  page_id: string;
  author_id: string;
  body_md: string;
  status: "open" | "resolved" | "deleted";
  created_at: string;
  updated_at: string;
  mentioned_user_ids: string;
}

interface IdRow extends Record<string, unknown> {
  id: string;
}

interface SubtreePathRow extends Record<string, unknown> {
  id: string;
  parent_id: string | null;
  slug: string;
  depth: number;
}

interface TrashBatchRow extends Record<string, unknown> {
  trash_batch_id: string;
}

interface PermissionRow extends Record<string, unknown> {
  permission: "editor" | "viewer" | null;
}

interface IdentityUserRow extends UserRow {
  external_subject: string;
}

interface IdempotencyRow extends Record<string, unknown> {
  page_id: string;
  request_hash: string;
  expires_at: string;
}

export interface PageVersionStorageRecord {
  id: string;
  pageId: string;
  revision: number;
  r2Key: string;
  contentHash: string;
  authorId: string;
  reason: PageVersion["reason"];
  storageStatus: PageVersion["storageStatus"];
  createdAt: string;
}

export interface StoredPageMutation {
  page: Page;
  version: PageVersionStorageRecord;
}

export interface PageMutationInput {
  pageId: string;
  baseRevision: number;
  parentId: string | null;
  slug: string;
  title: string;
  bodyMd: string;
  contentHash: string;
  authorId: string;
  reason: PageVersion["reason"];
  previousAliases?: { pageId: string; normalizedPath: string }[];
}

export interface PageCreationIdempotency {
  userId: string;
  keyHash: string;
  requestHash: string;
  expiresAt: string;
}

export class D1WikiRepository {
  public constructor(private readonly database: D1Database) {}

  public async findUserById(userId: string): Promise<User | null> {
    const row = await this.database
      .prepare("SELECT * FROM users WHERE id = ?")
      .bind(userId)
      .first<UserRow>();
    return row === null ? null : mapUser(row);
  }

  public async resolveAccessIdentity(
    claims: AccessJwtClaims,
    workspaceId = DEFAULT_WORKSPACE_ID,
  ): Promise<AuthenticatedIdentity> {
    const existingIdentity = await this.database
      .prepare(
        `SELECT u.*, e.external_subject
         FROM external_identities e
         JOIN users u ON u.id = e.user_id
         WHERE e.provider = 'cloudflare_access'
           AND e.external_subject = ?
           AND u.workspace_id = ?`,
      )
      .bind(claims.sub, workspaceId)
      .first<IdentityUserRow>();
    if (existingIdentity !== null) {
      return mapIdentity(existingIdentity, claims);
    }

    let user = await this.database
      .prepare(
        "SELECT * FROM users WHERE workspace_id = ? AND lower(email) = lower(?)",
      )
      .bind(workspaceId, claims.email)
      .first<UserRow>();

    if (user === null) {
      const now = new Date().toISOString();
      const userId = createUuidV7();
      await this.database
        .prepare(
          `INSERT OR IGNORE INTO users
             (id, workspace_id, email, display_name, role, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'viewer', 'active', ?, ?)`,
        )
        .bind(
          userId,
          workspaceId,
          claims.email.trim().toLocaleLowerCase("en-US"),
          preferredDisplayName(claims),
          now,
          now,
        )
        .run();
      user = await this.database
        .prepare(
          "SELECT * FROM users WHERE workspace_id = ? AND lower(email) = lower(?)",
        )
        .bind(workspaceId, claims.email)
        .first<UserRow>();
    }

    if (user === null) {
      throw new ApiProblem(
        "INTERNAL_ERROR",
        500,
        "The authenticated user could not be provisioned",
      );
    }

    await this.database
      .prepare(
        `INSERT OR IGNORE INTO external_identities
           (provider, external_subject, user_id, linked_at)
         VALUES ('cloudflare_access', ?, ?, ?)`,
      )
      .bind(claims.sub, user.id, new Date().toISOString())
      .run();

    const linkedUser = await this.database
      .prepare(
        `SELECT u.*, e.external_subject
         FROM external_identities e
         JOIN users u ON u.id = e.user_id
         WHERE e.provider = 'cloudflare_access' AND e.external_subject = ?`,
      )
      .bind(claims.sub)
      .first<IdentityUserRow>();
    if (linkedUser?.id !== user.id) {
      throw new ApiProblem(
        "AUTHENTICATION_REQUIRED",
        401,
        "The authenticated identity is linked to another user",
      );
    }
    return mapIdentity(linkedUser, claims);
  }

  public async getPage(pageId: string): Promise<Page | null> {
    const row = await this.database
      .prepare("SELECT * FROM pages WHERE id = ?")
      .bind(pageId)
      .first<PageRow>();
    return row === null ? null : mapPage(row);
  }

  public async getTagsForPage(
    pageId: string,
  ): Promise<{ id: string; name: string }[]> {
    const result = await this.database
      .prepare(
        `SELECT t.id, t.name
         FROM tags t
         JOIN page_tags pt ON pt.tag_id = t.id
         WHERE pt.page_id = ?
         ORDER BY t.normalized_name`,
      )
      .bind(pageId)
      .all<{ id: string; name: string }>();
    return result.results;
  }

  public async getRestrictedAncestorPermissions(
    pageId: string,
    workspaceId: string,
    userId: string,
  ): Promise<("editor" | "viewer" | null)[]> {
    const result = await this.database
      .prepare(
        `WITH RECURSIVE lineage(id, parent_id, access_mode, depth) AS (
           SELECT id, parent_id, access_mode, 0
           FROM pages
           WHERE id = ? AND workspace_id = ?
           UNION ALL
           SELECT parent.id, parent.parent_id, parent.access_mode, lineage.depth + 1
           FROM pages parent
           JOIN lineage ON parent.id = lineage.parent_id
           WHERE parent.workspace_id = ?
         )
         SELECT acl.permission
         FROM lineage
         LEFT JOIN page_acl acl ON acl.page_id = lineage.id AND acl.user_id = ?
         WHERE lineage.access_mode = 'restricted'
         ORDER BY lineage.depth`,
      )
      .bind(pageId, workspaceId, workspaceId, userId)
      .all<PermissionRow>();
    return result.results.map((row) => row.permission);
  }

  public async createPage(
    page: Page,
    version: PageVersionStorageRecord,
    restrictedCreatorPermission: "editor" | null,
    idempotency?: PageCreationIdempotency,
  ): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.database
        .prepare(
          `INSERT INTO pages
             (id, workspace_id, parent_id, slug, title, body_md, revision,
              content_hash, access_mode, status, created_by, created_at,
              updated_at, trashed_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active',
                  ?10, ?11, ?12, NULL
            WHERE ?3 IS NULL OR EXISTS (
              SELECT 1 FROM pages AS parent
               WHERE parent.id = ?3 AND parent.workspace_id = ?2
                 AND parent.status = 'active'
            )`,
        )
        .bind(
          page.id,
          page.workspaceId,
          page.parentId,
          page.slug,
          page.title,
          page.bodyMd,
          page.revision,
          page.contentHash,
          page.accessMode,
          page.createdBy,
          page.createdAt,
          page.updatedAt,
        ),
      this.versionInsertStatement(version),
      this.outboxInsertStatement(version, page.bodyMd),
      this.database
        .prepare(
          `INSERT INTO index_state
             (page_id, desired_hash, indexed_hash, status, last_error, updated_at)
           VALUES (?, ?, NULL, 'pending', NULL, ?)`,
        )
        .bind(page.id, page.contentHash, page.updatedAt),
    ];
    if (restrictedCreatorPermission !== null) {
      statements.push(
        this.database
          .prepare(
            `INSERT INTO page_acl
               (page_id, user_id, permission, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(
            page.id,
            page.createdBy,
            restrictedCreatorPermission,
            page.createdAt,
            page.createdAt,
          ),
      );
    }
    if (idempotency !== undefined) {
      statements.push(
        this.database
          .prepare(
            `INSERT INTO page_create_idempotency
               (user_id, key_hash, request_hash, page_id, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            idempotency.userId,
            idempotency.keyHash,
            idempotency.requestHash,
            page.id,
            page.createdAt,
            idempotency.expiresAt,
          ),
      );
    }

    try {
      await this.database.batch(statements);
    } catch (error) {
      if (page.parentId !== null) {
        const activeParent = await this.database
          .prepare(
            `SELECT id FROM pages
              WHERE id = ?1 AND workspace_id = ?2 AND status = 'active'`,
          )
          .bind(page.parentId, page.workspaceId)
          .first<IdRow>();
        if (activeParent === null) throw pageNotFound();
      }
      if (isD1UniqueConstraintError(error)) {
        if (
          error instanceof Error &&
          /page_create_idempotency/i.test(error.message)
        ) {
          throw new ApiProblem(
            "IDEMPOTENCY_CONFLICT",
            409,
            "This idempotency key has already been used",
          );
        }
        throw new ApiProblem(
          "PAGE_SLUG_CONFLICT",
          409,
          "A page with this slug already exists at the destination",
        );
      }
      throw error;
    }
  }

  public async getPageCreationIdempotency(
    userId: string,
    keyHash: string,
  ): Promise<{ pageId: string; requestHash: string; expiresAt: string } | null> {
    const row = await this.database
      .prepare(
        `SELECT page_id, request_hash, expires_at
         FROM page_create_idempotency
         WHERE user_id = ? AND key_hash = ?`,
      )
      .bind(userId, keyHash)
      .first<IdempotencyRow>();
    return row === null
      ? null
      : {
          pageId: row.page_id,
          requestHash: row.request_hash,
          expiresAt: row.expires_at,
        };
  }

  public async deleteExpiredPageCreationIdempotency(
    userId: string,
    keyHash: string,
    now: string,
  ): Promise<void> {
    await this.database
      .prepare(
        `DELETE FROM page_create_idempotency
         WHERE user_id = ? AND key_hash = ? AND expires_at <= ?`,
      )
      .bind(userId, keyHash, now)
      .run();
  }

  public async mutatePage(input: PageMutationInput): Promise<StoredPageMutation> {
    const page = await this.getPage(input.pageId);
    if (page?.status !== "active") {
      throw pageNotFound();
    }
    const revision = input.baseRevision + 1;
    const updatedAt = new Date().toISOString();
    const version: PageVersionStorageRecord = {
      id: createUuidV7(),
      pageId: input.pageId,
      revision,
      r2Key: `versions/${page.workspaceId}/${page.id}/${String(revision)}.md`,
      contentHash: input.contentHash,
      authorId: input.authorId,
      reason: input.reason,
      storageStatus: "pending",
      createdAt: updatedAt,
    };

    const statements: D1PreparedStatement[] = [
      this.database
        .prepare(
          `WITH RECURSIVE subtree(id) AS (
             SELECT id FROM pages WHERE id = ?9
             UNION
             SELECT child.id FROM pages child
             JOIN subtree ON child.parent_id = subtree.id
           )
           UPDATE pages
           SET parent_id = ?1, slug = ?2, title = ?3, body_md = ?4, revision = ?5,
               content_hash = ?6, updated_at = ?7, last_mutation_id = ?8
           WHERE id = ?9 AND revision = ?10 AND status = 'active'
             AND (
               ?1 IS NULL OR (
                 EXISTS (
                   SELECT 1 FROM pages destination
                   WHERE destination.id = ?1
                     AND destination.workspace_id = pages.workspace_id
                     AND destination.status = 'active'
                 )
                 AND NOT EXISTS (SELECT 1 FROM subtree WHERE id = ?1)
               )
             )`,
        )
        .bind(
          input.parentId,
          input.slug,
          input.title,
          input.bodyMd,
          revision,
          input.contentHash,
          updatedAt,
          version.id,
          input.pageId,
          input.baseRevision,
        ),
      this.database
        .prepare(
          `INSERT INTO page_versions
             (id, page_id, revision, r2_key, content_hash, author_id, reason,
              storage_status, storage_error, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?
           FROM pages WHERE id = ? AND revision = ? AND last_mutation_id = ?`,
        )
        .bind(
          version.id,
          version.pageId,
          version.revision,
          version.r2Key,
          version.contentHash,
          version.authorId,
          version.reason,
          version.createdAt,
          input.pageId,
          revision,
          version.id,
        ),
      this.database
        .prepare(
          `INSERT INTO page_version_outbox
             (version_id, body_md, attempts, available_at, created_at, updated_at)
           SELECT ?, ?, 0, ?, ?, ?
           FROM page_versions WHERE id = ?`,
        )
        .bind(
          version.id,
          input.bodyMd,
          updatedAt,
          updatedAt,
          updatedAt,
          version.id,
        ),
      this.database
        .prepare(
          `INSERT INTO index_state
             (page_id, desired_hash, indexed_hash, status, last_error, updated_at)
           SELECT ?, ?, NULL, 'pending', NULL, ?
           FROM page_versions WHERE id = ?
           ON CONFLICT(page_id) DO UPDATE SET
             desired_hash = excluded.desired_hash,
             status = 'pending',
             last_error = NULL,
             updated_at = excluded.updated_at`,
        )
        .bind(
          input.pageId,
          input.contentHash,
          updatedAt,
          version.id,
        ),
    ];
    for (const alias of input.previousAliases ?? []) {
      statements.push(
        this.database
          .prepare(
            `INSERT OR IGNORE INTO page_aliases
               (workspace_id, normalized_path, page_id, created_at)
             SELECT ?, ?, ?, ? FROM page_versions WHERE id = ?`,
          )
          .bind(
            page.workspaceId,
            normalizeWikiPath(alias.normalizedPath),
            alias.pageId,
            updatedAt,
            version.id,
          ),
      );
    }

    let results: D1Result[];
    try {
      results = await this.database.batch(statements);
    } catch (error) {
      if (isD1UniqueConstraintError(error)) {
        throw new ApiProblem(
          "PAGE_SLUG_CONFLICT",
          409,
          "A page with this slug already exists at the destination",
        );
      }
      throw error;
    }
    if (results[0]?.meta.changes !== 1) {
      const current = await this.getPage(input.pageId);
      if (
        current?.status === "active" &&
        current.revision === input.baseRevision
      ) {
        throw new ApiProblem(
          "INVALID_PAGE_MOVE",
          409,
          "The destination is unavailable or belongs to the page subtree",
        );
      }
      throw new ApiProblem(
        "REVISION_CONFLICT",
        409,
        "The page changed after it was loaded",
        {
          baseRevision: input.baseRevision,
          currentRevision: current?.revision,
          currentContentHash: current?.contentHash,
        },
      );
    }

    const updated = await this.getPage(input.pageId);
    if (updated === null) {
      throw pageNotFound();
    }
    return { page: updated, version };
  }

  public async markVersionStored(versionId: string): Promise<void> {
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE page_versions
           SET storage_status = 'ready', storage_error = NULL
           WHERE id = ?`,
        )
        .bind(versionId),
      this.database
        .prepare("DELETE FROM page_version_outbox WHERE version_id = ?")
        .bind(versionId),
    ]);
  }

  public async markVersionStorageFailed(
    versionId: string,
    message: string,
  ): Promise<void> {
    const now = new Date();
    const retryAt = new Date(now.getTime() + 60_000).toISOString();
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE page_versions
           SET storage_status = 'failed', storage_error = ?
           WHERE id = ?`,
        )
        .bind(message.slice(0, 1_000), versionId),
      this.database
        .prepare(
          `UPDATE page_version_outbox
           SET attempts = attempts + 1, available_at = ?, updated_at = ?
           WHERE version_id = ?`,
        )
        .bind(retryAt, now.toISOString(), versionId),
    ]);
  }

  public async listVersions(pageId: string): Promise<PageVersion[]> {
    const result = await this.database
      .prepare(
        `SELECT * FROM page_versions
         WHERE page_id = ?
         ORDER BY revision DESC`,
      )
      .bind(pageId)
      .all<PageVersionRow>();
    return result.results.map(mapPageVersion);
  }

  public async getVersion(
    pageId: string,
    versionId: string,
  ): Promise<PageVersionStorageRecord | null> {
    const row = await this.database
      .prepare("SELECT * FROM page_versions WHERE page_id = ? AND id = ?")
      .bind(pageId, versionId)
      .first<PageVersionRow>();
    return row === null ? null : mapStorageVersion(row);
  }

  public async listVisiblePageTree(
    identity: AuthenticatedIdentity,
  ): Promise<PageTreeNode[]> {
    const result =
      identity.role === "owner"
        ? await this.database
            .prepare(
              `SELECT id, parent_id, slug, title, access_mode, updated_at
               FROM pages
               WHERE workspace_id = ? AND status = 'active'
               ORDER BY title COLLATE NOCASE, id`,
            )
            .bind(identity.workspaceId)
            .all<PageSummaryRow>()
        : await this.database
            .prepare(
              `WITH RECURSIVE lineage(page_id, ancestor_id, parent_id, access_mode, depth) AS (
                 SELECT id, id, parent_id, access_mode, 0
                 FROM pages
                 WHERE workspace_id = ? AND status = 'active'
                 UNION ALL
                 SELECT lineage.page_id, parent.id, parent.parent_id,
                        parent.access_mode, lineage.depth + 1
                 FROM lineage
                 JOIN pages parent ON parent.id = lineage.parent_id
                 WHERE parent.workspace_id = ?
               )
               SELECT p.id, p.parent_id, p.slug, p.title, p.access_mode, p.updated_at
               FROM pages p
               WHERE p.workspace_id = ? AND p.status = 'active'
                 AND NOT EXISTS (
                   SELECT 1
                   FROM lineage restricted
                   WHERE restricted.page_id = p.id
                     AND restricted.access_mode = 'restricted'
                     AND NOT EXISTS (
                       SELECT 1 FROM page_acl acl
                       WHERE acl.page_id = restricted.ancestor_id AND acl.user_id = ?
                     )
                 )
               ORDER BY p.title COLLATE NOCASE, p.id`,
            )
            .bind(
              identity.workspaceId,
              identity.workspaceId,
              identity.workspaceId,
              identity.id,
            )
            .all<PageSummaryRow>();
    return buildPageTree(result.results);
  }

  public async isPageInSubtree(
    rootPageId: string,
    candidatePageId: string,
  ): Promise<boolean> {
    const row = await this.database
      .prepare(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM pages WHERE id = ?
           UNION ALL
           SELECT child.id FROM pages child JOIN subtree ON child.parent_id = subtree.id
         )
         SELECT id FROM subtree WHERE id = ? LIMIT 1`,
      )
      .bind(rootPageId, candidatePageId)
      .first<IdRow>();
    return row !== null;
  }

  public async getPagePath(pageId: string): Promise<string> {
    const result = await this.database
      .prepare(
        `WITH RECURSIVE lineage(id, parent_id, slug, depth) AS (
           SELECT id, parent_id, slug, 0 FROM pages WHERE id = ?
           UNION ALL
           SELECT parent.id, parent.parent_id, parent.slug, lineage.depth + 1
           FROM pages parent JOIN lineage ON parent.id = lineage.parent_id
         )
         SELECT slug FROM lineage ORDER BY depth DESC`,
      )
      .bind(pageId)
      .all<{ slug: string }>();
    return `/${result.results.map((row) => row.slug).join("/")}`;
  }

  public async listSubtreePagePaths(
    pageId: string,
  ): Promise<{ pageId: string; normalizedPath: string }[]> {
    const rootPath = normalizeWikiPath(await this.getPagePath(pageId));
    const result = await this.database
      .prepare(
        `WITH RECURSIVE subtree(id, parent_id, slug, depth) AS (
           SELECT id, parent_id, slug, 0
           FROM pages WHERE id = ? AND status = 'active'
           UNION ALL
           SELECT child.id, child.parent_id, child.slug, subtree.depth + 1
           FROM pages child JOIN subtree ON child.parent_id = subtree.id
           WHERE child.status = 'active'
         )
         SELECT id, parent_id, slug, depth FROM subtree ORDER BY depth, id`,
      )
      .bind(pageId)
      .all<SubtreePathRow>();
    const paths = new Map<string, string>();
    for (const row of result.results) {
      const path = row.depth === 0
        ? rootPath
        : `${paths.get(row.parent_id ?? "") ?? rootPath}/${row.slug}`;
      paths.set(row.id, normalizeWikiPath(path));
    }
    return result.results.map((row) => ({
      pageId: row.id,
      normalizedPath: paths.get(row.id) ?? rootPath,
    }));
  }

  public async trashSubtree(pageId: string): Promise<string[]> {
    const now = new Date().toISOString();
    const trashBatchId = createUuidV7();
    const results = await this.database.batch<IdRow>([
      this.database
        .prepare(
          `WITH RECURSIVE subtree(id) AS (
             SELECT id FROM pages WHERE id = ? AND status = 'active'
             UNION ALL
             SELECT child.id FROM pages child
             JOIN subtree ON child.parent_id = subtree.id
             WHERE child.status = 'active'
           )
           UPDATE pages
           SET status = 'trashed', trashed_at = ?, trash_batch_id = ?,
               updated_at = ?, last_mutation_id = ?
           WHERE id IN (SELECT id FROM subtree)
           RETURNING id`,
        )
        .bind(pageId, now, trashBatchId, now, trashBatchId),
      this.database
        .prepare(
          `WITH RECURSIVE subtree(id) AS (
             SELECT id FROM pages WHERE id = ? AND last_mutation_id = ?
             UNION ALL
             SELECT child.id FROM pages child JOIN subtree ON child.parent_id = subtree.id
             WHERE child.last_mutation_id = ?
           )
           UPDATE index_state
           SET status = 'deleted', updated_at = ?
           WHERE page_id IN (SELECT id FROM subtree)`,
        )
        .bind(pageId, trashBatchId, trashBatchId, now),
    ]);
    return (results[0]?.results ?? []).map((row) => row.id);
  }

  public async listActiveSubtreePageIds(pageId: string): Promise<string[]> {
    const result = await this.database
      .prepare(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM pages WHERE id = ?1 AND status = 'active'
           UNION ALL
           SELECT child.id FROM pages AS child
           JOIN subtree ON child.parent_id = subtree.id
           WHERE child.status = 'active'
         )
         SELECT id FROM subtree ORDER BY id`,
      )
      .bind(pageId)
      .all<IdRow>();
    return result.results.map((row) => row.id);
  }

  public async restrictedBoundaryId(pageId: string): Promise<string | null> {
    const row = await this.database
      .prepare(
        `WITH RECURSIVE ancestors(id, parent_id, access_mode, depth) AS (
           SELECT id, parent_id, access_mode, 0
           FROM pages WHERE id = ?1 AND status = 'active'
           UNION ALL
           SELECT parent.id, parent.parent_id, parent.access_mode, child.depth + 1
           FROM pages parent
           JOIN ancestors child ON child.parent_id = parent.id
           WHERE parent.status = 'active'
         )
         SELECT id FROM ancestors
         WHERE access_mode = 'restricted'
         ORDER BY depth ASC
         LIMIT 1`,
      )
      .bind(pageId)
      .first<IdRow>();
    return row?.id ?? null;
  }

  public async restoreSubtree(
    pageId: string,
    allowOrphanToRoot: boolean,
  ): Promise<string[]> {
    const now = new Date().toISOString();
    const trashBatch = await this.database
      .prepare(
        `SELECT trash_batch_id FROM pages
         WHERE id = ? AND status = 'trashed' AND trash_batch_id IS NOT NULL`,
      )
      .bind(pageId)
      .first<TrashBatchRow>();
    if (trashBatch === null) return [];
    const restoreMutationId = createUuidV7();
    const root = await this.getPage(pageId);
    if (root === null) return [];
    const restoredSlug = restorationSlug(root.slug, now.slice(0, 10), root.id);
    try {
      const results = await this.database.batch<IdRow>([
        this.database
          .prepare(
            `WITH RECURSIVE destination(parent_id) AS (
               SELECT CASE
                 WHEN root.parent_id IS NULL OR EXISTS (
                   SELECT 1 FROM pages parent
                   WHERE parent.id = root.parent_id
                     AND parent.workspace_id = root.workspace_id
                     AND parent.status = 'active'
                 ) THEN root.parent_id
                 ELSE NULL
               END
               FROM pages root WHERE root.id = ?1
             ), subtree(id) AS (
               SELECT id FROM pages
               WHERE id = ?1 AND status = 'trashed' AND trash_batch_id = ?2
                 AND (
                   parent_id IS NULL OR ?6 = 1 OR EXISTS (
                     SELECT 1 FROM pages active_parent
                     WHERE active_parent.id = pages.parent_id
                       AND active_parent.workspace_id = pages.workspace_id
                       AND active_parent.status = 'active'
                   )
                 )
               UNION ALL
               SELECT child.id FROM pages child
               JOIN subtree ON child.parent_id = subtree.id
               WHERE child.status = 'trashed' AND child.trash_batch_id = ?2
             )
             UPDATE pages
             SET parent_id = CASE
                   WHEN id = ?1 THEN (SELECT parent_id FROM destination)
                   ELSE parent_id
                 END,
                 slug = CASE
                   WHEN id = ?1 AND EXISTS (
                     SELECT 1 FROM pages occupied
                     WHERE occupied.workspace_id = pages.workspace_id
                       AND ifnull(occupied.parent_id, '') =
                           ifnull((SELECT parent_id FROM destination), '')
                       AND occupied.slug = pages.slug
                       AND occupied.status = 'active'
                       AND occupied.id <> pages.id
                   ) THEN ?3
                   ELSE slug
                 END,
                 status = 'active', trashed_at = NULL, trash_batch_id = NULL,
                 updated_at = ?4, last_mutation_id = ?5
             WHERE id IN (SELECT id FROM subtree)
             RETURNING id`,
          )
          .bind(
            pageId,
            trashBatch.trash_batch_id,
            restoredSlug,
            now,
            restoreMutationId,
            allowOrphanToRoot ? 1 : 0,
          ),
        this.database
          .prepare(
            `WITH RECURSIVE subtree(id) AS (
               SELECT id FROM pages WHERE id = ? AND last_mutation_id = ?
               UNION ALL
               SELECT child.id FROM pages child JOIN subtree ON child.parent_id = subtree.id
               WHERE child.last_mutation_id = ?
             )
             UPDATE index_state
             SET status = 'pending', indexed_hash = NULL, last_error = NULL, updated_at = ?
             WHERE page_id IN (SELECT id FROM subtree)`,
          )
          .bind(pageId, restoreMutationId, restoreMutationId, now),
      ]);
      return (results[0]?.results ?? []).map((row) => row.id);
    } catch (error) {
      if (isD1UniqueConstraintError(error)) {
        throw new ApiProblem(
          "PAGE_SLUG_CONFLICT",
          409,
          "The page cannot be restored because its path is occupied",
        );
      }
      throw error;
    }
  }

  public async listComments(pageId: string): Promise<Comment[]> {
    const result = await this.database
      .prepare(
        `SELECT c.*,
                coalesce(group_concat(m.mentioned_user_id, ','), '') AS mentioned_user_ids
         FROM comments c
         LEFT JOIN mentions m ON m.comment_id = c.id
         WHERE c.page_id = ? AND c.status <> 'deleted'
         GROUP BY c.id
         ORDER BY c.created_at ASC`,
      )
      .bind(pageId)
      .all<CommentRow>();
    return result.results.map(mapComment);
  }

  public async createComment(
    pageId: string,
    authorId: string,
    workspaceId: string,
    bodyMd: string,
    mentionedUserIds: string[],
  ): Promise<Comment> {
    const commentId = createUuidV7();
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [
      this.database
        .prepare(
          `INSERT INTO comments
             (id, page_id, author_id, body_md, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'open', ?, ?)`,
        )
        .bind(commentId, pageId, authorId, bodyMd, now, now),
    ];
    for (const mentionedUserId of new Set(mentionedUserIds)) {
      statements.push(
        this.database
          .prepare(
            `INSERT INTO mentions (comment_id, mentioned_user_id, read_at)
             SELECT ?, id, NULL FROM users
             WHERE id = ? AND workspace_id = ? AND status = 'active'`,
          )
          .bind(commentId, mentionedUserId, workspaceId),
      );
    }
    await this.database.batch(statements);
    const comments = await this.listComments(pageId);
    const created = comments.find((comment) => comment.id === commentId);
    if (created === undefined) {
      throw new ApiProblem("INTERNAL_ERROR", 500, "The comment could not be read");
    }
    return created;
  }

  private versionInsertStatement(
    version: PageVersionStorageRecord,
  ): D1PreparedStatement {
    return this.database
      .prepare(
        `INSERT INTO page_versions
           (id, page_id, revision, r2_key, content_hash, author_id, reason,
            storage_status, storage_error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .bind(
        version.id,
        version.pageId,
        version.revision,
        version.r2Key,
        version.contentHash,
        version.authorId,
        version.reason,
        version.storageStatus,
        version.createdAt,
      );
  }

  private outboxInsertStatement(
    version: PageVersionStorageRecord,
    bodyMd: string,
  ): D1PreparedStatement {
    return this.database
      .prepare(
        `INSERT INTO page_version_outbox
           (version_id, body_md, attempts, available_at, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?)`,
      )
      .bind(
        version.id,
        bodyMd,
        version.createdAt,
        version.createdAt,
        version.createdAt,
      );
  }
}

function restorationSlug(slug: string, date: string, pageId: string): string {
  const suffix = `-restored-${date}-${pageId.toLocaleLowerCase("en-US")}`;
  return `${slug.slice(0, Math.max(1, 200 - suffix.length))}${suffix}`;
}

export function pageNotFound(): ApiProblem {
  return new ApiProblem(
    "PAGE_NOT_FOUND",
    404,
    "Page was not found or is not visible",
  );
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapIdentity(
  row: IdentityUserRow,
  claims: AccessJwtClaims,
): AuthenticatedIdentity {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    subject: claims.sub,
    expiresAt: claims.exp,
  };
}

function mapPage(row: PageRow): Page {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    parentId: row.parent_id,
    slug: row.slug,
    title: row.title,
    bodyMd: row.body_md,
    revision: row.revision,
    contentHash: row.content_hash,
    accessMode: row.access_mode,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trashedAt: row.trashed_at,
  };
}

function mapPageVersion(row: PageVersionRow): PageVersion {
  return {
    id: row.id,
    pageId: row.page_id,
    revision: row.revision,
    contentHash: row.content_hash,
    authorId: row.author_id,
    reason: row.reason,
    storageStatus: row.storage_status,
    createdAt: row.created_at,
  };
}

function mapStorageVersion(row: PageVersionRow): PageVersionStorageRecord {
  return {
    ...mapPageVersion(row),
    r2Key: row.r2_key,
  };
}

function mapComment(row: CommentRow): Comment {
  return {
    id: row.id,
    pageId: row.page_id,
    authorId: row.author_id,
    bodyMd: row.body_md,
    status: row.status,
    mentionedUserIds:
      row.mentioned_user_ids.length === 0
        ? []
        : row.mentioned_user_ids.split(","),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildPageTree(rows: PageSummaryRow[]): PageTreeNode[] {
  const nodes = new Map<string, PageTreeNode>();
  for (const row of rows) {
    nodes.set(row.id, {
      id: row.id,
      parentId: row.parent_id,
      slug: row.slug,
      title: row.title,
      accessMode: row.access_mode,
      updatedAt: row.updated_at,
      children: [],
    });
  }

  const roots: PageTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId === null ? undefined : nodes.get(node.parentId);
    if (parent === undefined) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }
  return roots;
}

export function clampPermissionToWorkspaceRole(
  workspaceRole: AuthenticatedIdentity["role"],
  aclPermission: "editor" | "viewer" | null,
): PagePermission {
  if (workspaceRole === "owner") return "owner";
  if (aclPermission === null) return "none";
  if (workspaceRole === "viewer" || aclPermission === "viewer") return "viewer";
  return "editor";
}

function preferredDisplayName(claims: AccessJwtClaims): string {
  const name = claims.name?.trim();
  return name === undefined || name.length === 0 ? claims.email : name;
}
