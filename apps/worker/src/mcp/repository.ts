import { normalizeWikiPath } from "@nago-wiki/shared";
import { D1SearchCandidateAuthorizer } from "../ai/authorizer";
import type { AuthorizedChunk, SearchCandidate } from "../ai/contracts";

interface PageRow {
  id: string;
  workspace_id: string;
  title: string;
  body_md: string;
  content_hash: string;
}

interface PageSummaryRow {
  id: string;
  workspace_id: string;
  title: string;
  sort_title: string;
}

export interface ReadablePage {
  id: string;
  workspaceId: string;
  title: string;
  bodyMarkdown: string;
  path: string;
  url: string;
}

export type ReadablePageSummary = Omit<ReadablePage, "bodyMarkdown">;

export interface PageCursor {
  sortTitle: string;
  id: string;
}

export interface ReadablePageList {
  pages: ReadablePageSummary[];
  nextCursor: PageCursor | null;
}

export class McpWikiRepository {
  private readonly authorizer: D1SearchCandidateAuthorizer;
  private readonly publicOrigin: string;

  public constructor(
    private readonly database: D1Database,
    publicOrigin: string,
  ) {
    this.authorizer = new D1SearchCandidateAuthorizer(database, publicOrigin);
    this.publicOrigin = publicOrigin;
  }

  public async getPage(
    userId: string,
    workspaceId: string,
    pageId: string,
  ): Promise<ReadablePage | null> {
    const page = await this.database
      .prepare(
        `SELECT id, workspace_id, title, body_md, content_hash
           FROM pages
          WHERE id = ?1 AND workspace_id = ?2 AND status = 'active'`,
      )
      .bind(pageId, workspaceId)
      .first<PageRow>();
    if (page === null) {
      return null;
    }

    const authorized = await this.authorizeRow(userId, page);
    return authorized === null
      ? null
      : {
          id: page.id,
          workspaceId: page.workspace_id,
          title: page.title,
          bodyMarkdown: page.body_md,
          path: authorized.path,
          url: authorized.url,
        };
  }

  public async getPageByPath(
    userId: string,
    workspaceId: string,
    path: string,
  ): Promise<ReadablePage | null> {
    const normalizedPath = normalizeWikiPath(path);
    const match = await this.database
      .prepare(
        `SELECT page_id
           FROM page_aliases
          WHERE workspace_id = ?1 AND normalized_path = ?2`,
      )
      .bind(workspaceId, normalizedPath)
      .first<{ page_id: string }>();
    if (match !== null) return this.getPage(userId, workspaceId, match.page_id);

    const slug = normalizedPath.split("/").at(-1) ?? "";
    const current = await this.database
      .prepare(
        `SELECT id FROM pages
          WHERE workspace_id = ?1 AND lower(slug) = ?2 AND status = 'active'
          ORDER BY updated_at DESC LIMIT 2`,
      )
      .bind(workspaceId, slug)
      .all<{ id: string }>();
    const resolved = current.results[0];
    if (current.results.length !== 1 || resolved === undefined) return null;
    return this.getPage(userId, workspaceId, resolved.id);
  }

  public async listChildren(
    userId: string,
    workspaceId: string,
    parentPageId: string | null,
    cursor: PageCursor | null = null,
    limit = 50,
  ): Promise<ReadablePageList> {
    const pageSize = Math.max(1, Math.min(50, limit));
    const rows = await this.database
      .prepare(
        `WITH RECURSIVE lineage(page_id, ancestor_id, parent_id, access_mode) AS (
           SELECT id, id, parent_id, access_mode
             FROM pages
            WHERE workspace_id = ?1 AND status = 'active'
           UNION ALL
           SELECT lineage.page_id, parent.id, parent.parent_id, parent.access_mode
             FROM lineage
             JOIN pages AS parent ON parent.id = lineage.parent_id
            WHERE parent.workspace_id = ?1 AND parent.status = 'active'
         ),
         visible_pages AS (
           SELECT page.id,
                  page.workspace_id,
                  page.title,
                  lower(page.title) AS sort_title
             FROM pages AS page
             JOIN users AS member ON member.id = ?2
                                 AND member.workspace_id = page.workspace_id
                                 AND member.status = 'active'
            WHERE page.workspace_id = ?1
              AND page.status = 'active'
              AND ((?3 IS NULL AND page.parent_id IS NULL) OR page.parent_id = ?3)
              AND (
                member.role = 'owner' OR NOT EXISTS (
                  SELECT 1
                    FROM lineage AS restricted
                   WHERE restricted.page_id = page.id
                     AND restricted.access_mode = 'restricted'
                     AND NOT EXISTS (
                       SELECT 1
                         FROM page_acl AS acl
                        WHERE acl.page_id = restricted.ancestor_id
                          AND acl.user_id = member.id
                          AND acl.permission IN ('viewer', 'editor')
                     )
                )
              )
         )
         SELECT id, workspace_id, title, sort_title
           FROM visible_pages
          WHERE (
              ?4 IS NULL OR sort_title > ?4
              OR (sort_title = ?4 AND id > ?5)
            )
          ORDER BY sort_title ASC, id ASC
          LIMIT ?6`,
      )
      .bind(
        workspaceId,
        userId,
        parentPageId,
        cursor?.sortTitle ?? null,
        cursor?.id ?? "",
        pageSize + 1,
      )
      .all<PageSummaryRow>();
    return this.pageSummaries(rows.results, pageSize);
  }

  public async getBacklinks(
    userId: string,
    workspaceId: string,
    targetPageId: string,
    cursor: PageCursor | null = null,
    limit = 50,
  ): Promise<ReadablePageList | null> {
    const target = await this.getPage(userId, workspaceId, targetPageId);
    if (target === null) return null;

    const pageSize = Math.max(1, Math.min(50, limit));
    const rows = await this.database
      .prepare(
        `WITH RECURSIVE lineage(page_id, ancestor_id, parent_id, access_mode) AS (
           SELECT id, id, parent_id, access_mode
             FROM pages
            WHERE workspace_id = ?1 AND status = 'active'
           UNION ALL
           SELECT lineage.page_id, parent.id, parent.parent_id, parent.access_mode
             FROM lineage
             JOIN pages AS parent ON parent.id = lineage.parent_id
            WHERE parent.workspace_id = ?1 AND parent.status = 'active'
         ),
         visible_sources AS (
           SELECT source.id,
                  source.workspace_id,
                  source.title,
                  lower(source.title) AS sort_title
             FROM pages AS source
             JOIN users AS member ON member.id = ?2
                                 AND member.workspace_id = source.workspace_id
                                 AND member.status = 'active'
            WHERE source.workspace_id = ?1
              AND source.status = 'active'
              AND EXISTS (
                SELECT 1
                  FROM page_links AS link
                 WHERE link.source_page_id = source.id
                   AND link.target_page_id = ?3
              )
              AND (
                member.role = 'owner' OR NOT EXISTS (
                  SELECT 1
                    FROM lineage AS restricted
                   WHERE restricted.page_id = source.id
                     AND restricted.access_mode = 'restricted'
                     AND NOT EXISTS (
                       SELECT 1
                         FROM page_acl AS acl
                        WHERE acl.page_id = restricted.ancestor_id
                          AND acl.user_id = member.id
                          AND acl.permission IN ('viewer', 'editor')
                     )
                )
              )
         )
         SELECT id, workspace_id, title, sort_title
           FROM visible_sources
          WHERE (
              ?4 IS NULL OR sort_title > ?4
              OR (sort_title = ?4 AND id > ?5)
            )
          ORDER BY sort_title ASC, id ASC
          LIMIT ?6`,
      )
      .bind(
        workspaceId,
        userId,
        targetPageId,
        cursor?.sortTitle ?? null,
        cursor?.id ?? "",
        pageSize + 1,
      )
      .all<PageSummaryRow>();
    return this.pageSummaries(rows.results, pageSize);
  }

  private pageSummaries(
    rows: PageSummaryRow[],
    pageSize: number,
  ): ReadablePageList {
    const selectedRows = rows.slice(0, pageSize);
    const last = selectedRows.at(-1);
    return {
      pages: selectedRows.map((page) => {
        const path = `/pages/${encodeURIComponent(page.id)}`;
        return {
          id: page.id,
          workspaceId: page.workspace_id,
          title: page.title,
          path,
          url: new URL(path, this.publicOrigin).toString(),
        };
      }),
      nextCursor:
        rows.length > pageSize && last !== undefined
          ? { sortTitle: last.sort_title, id: last.id }
          : null,
    };
  }

  private authorizeRow(userId: string, page: PageRow): Promise<AuthorizedChunk | null> {
    const candidate: SearchCandidate = {
      chunkId: `page:${page.id}`,
      key: `w/${page.workspace_id}/p/${page.id}.md`,
      pageId: page.id,
      workspaceId: page.workspace_id,
      contentHash: page.content_hash,
      text: page.body_md,
      score: 1,
    };
    return this.authorizer.authorize(userId, candidate, {});
  }
}
