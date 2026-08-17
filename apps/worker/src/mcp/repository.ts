import { D1SearchCandidateAuthorizer } from "../ai/authorizer";
import type { AuthorizedChunk, SearchCandidate } from "../ai/contracts";

interface PageRow {
  id: string;
  workspace_id: string;
  title: string;
  body_md: string;
  content_hash: string;
}

export interface ReadablePage {
  id: string;
  workspaceId: string;
  title: string;
  bodyMarkdown: string;
  path: string;
  url: string;
}

export class McpWikiRepository {
  private readonly authorizer: D1SearchCandidateAuthorizer;

  public constructor(
    private readonly database: D1Database,
    publicOrigin: string,
  ) {
    this.authorizer = new D1SearchCandidateAuthorizer(database, publicOrigin);
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
    const normalizedPath = path.trim().replace(/^\/+|\/+$/gu, "").toLowerCase();
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
  ): Promise<ReadablePage[]> {
    const rows = await this.database
      .prepare(
        `SELECT id, workspace_id, title, body_md, content_hash
           FROM pages
          WHERE workspace_id = ?1
            AND status = 'active'
            AND ((?2 IS NULL AND parent_id IS NULL) OR parent_id = ?2)
          ORDER BY title ASC
          LIMIT 200`,
      )
      .bind(workspaceId, parentPageId)
      .all<PageRow>();
    return this.filterReadable(userId, rows.results);
  }

  public async getBacklinks(
    userId: string,
    workspaceId: string,
    targetPageId: string,
  ): Promise<ReadablePage[]> {
    const rows = await this.database
      .prepare(
        `SELECT source.id,
                source.workspace_id,
                source.title,
                source.body_md,
                source.content_hash
           FROM page_links AS link
           JOIN pages AS source ON source.id = link.source_page_id
          WHERE link.target_page_id = ?1
            AND source.workspace_id = ?2
            AND source.status = 'active'
          ORDER BY source.title ASC
          LIMIT 200`,
      )
      .bind(targetPageId, workspaceId)
      .all<PageRow>();
    return this.filterReadable(userId, rows.results);
  }

  private async filterReadable(userId: string, rows: PageRow[]): Promise<ReadablePage[]> {
    const results = await Promise.all(
      rows.map(async (page) => {
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
      }),
    );
    return results.filter((page) => page !== null);
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
