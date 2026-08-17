import type { SearchCandidate, SearchRequest } from "./contracts";
import type { AuthorizedChunk } from "./contracts";

interface AuthorizedPageRow {
  id: string;
  title: string;
  slug: string;
  content_hash: string;
  authorized: number;
}

export interface SearchCandidateAuthorizer {
  authorize(
    userId: string,
    candidate: SearchCandidate,
    filters: Pick<SearchRequest, "parentPageId" | "tags">,
  ): Promise<AuthorizedChunk | null>;
}

/**
 * Re-authorizes every AI Search hit against canonical D1 state. AI Search
 * metadata is treated as an untrusted candidate hint, never as permission.
 */
export class D1SearchCandidateAuthorizer implements SearchCandidateAuthorizer {
  public constructor(
    private readonly database: D1Database,
    private readonly publicOrigin: string,
  ) {}

  public async authorize(
    userId: string,
    candidate: SearchCandidate,
    filters: Pick<SearchRequest, "parentPageId" | "tags">,
  ): Promise<AuthorizedChunk | null> {
    const row = await this.database
      .prepare(
        `WITH RECURSIVE lineage(id, parent_id, access_mode, depth) AS (
           SELECT id, parent_id, access_mode, 0
             FROM pages
            WHERE id = ?1 AND workspace_id = ?2 AND status = 'active'
           UNION ALL
           SELECT parent.id, parent.parent_id, parent.access_mode, lineage.depth + 1
             FROM pages AS parent
             JOIN lineage ON parent.id = lineage.parent_id
            WHERE parent.workspace_id = ?2 AND parent.status = 'active'
         ),
         nearest_restriction AS (
           SELECT id FROM lineage
            WHERE access_mode = 'restricted'
            ORDER BY depth ASC
            LIMIT 1
         )
         SELECT page.id,
                page.title,
                page.slug,
                page.content_hash,
                CASE
                  WHEN member.role = 'owner' THEN 1
                  WHEN NOT EXISTS (SELECT 1 FROM nearest_restriction) THEN 1
                  WHEN EXISTS (
                    SELECT 1
                      FROM page_acl
                     WHERE page_id = (SELECT id FROM nearest_restriction)
                       AND user_id = ?3
                       AND permission IN ('viewer', 'editor')
                  ) THEN 1
                  ELSE 0
                END AS authorized
           FROM pages AS page
           JOIN users AS member ON member.id = ?3 AND member.status = 'active'
          WHERE page.id = ?1
            AND page.workspace_id = ?2
            AND page.status = 'active'
            AND (?4 IS NULL OR page.parent_id = ?4)
            AND (
              ?5 IS NULL OR EXISTS (
                SELECT 1
                  FROM page_tags
                  JOIN tags ON tags.id = page_tags.tag_id
                 WHERE page_tags.page_id = page.id
                   AND tags.normalized_name IN (
                     SELECT value FROM json_each(?5)
                   )
              )
            )`,
      )
      .bind(
        candidate.pageId,
        candidate.workspaceId,
        userId,
        filters.parentPageId ?? null,
        filters.tags === undefined ? null : JSON.stringify(filters.tags),
      )
      .first<AuthorizedPageRow>();

    if (row?.authorized !== 1 || row.content_hash !== candidate.contentHash) {
      return null;
    }

    const path = `/pages/${encodeURIComponent(row.id)}`;
    return {
      chunkId: candidate.chunkId,
      pageId: row.id,
      title: row.title,
      path,
      url: new URL(path, this.publicOrigin).toString(),
      snippet: candidate.text,
      score: candidate.score,
      contentHash: row.content_hash,
    };
  }
}
